import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {INSERT_ONLY_SQLSTATE,INSERT_GUARD_SQLSTATE,SERIALIZABLE_SQLSTATE,migrateQuantComparison,rollbackQuantComparison,classifyQuantComparison,inspectQuantComparison}
  from '../../src/postgres/quant-comparison-migration.js';
import {migrateQuantExposureRegister} from '../../src/postgres/quant-exposure-register-migration.js';
import {createComparison,readComparison,writeEvaluation,writeBenchmark,writeOutcome,writeReplayEvent,readComparisonResults,MAX_RETRIES,BENCHMARK_ID,
  MAX_EVALUATION_BYTES,STORE_CODES} from '../../src/postgres/comparison-store.js';
import {validateSpec,decideOutcome} from '../../src/comparison/ranking.js';
import {CODES} from '../../src/comparison/common.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {hex,MINUTE,T0} from '../helpers/quant-library-fixture.mjs';

// QR-3 S2c-2: evaluation records (F3), benchmarks, outcomes with their atomic COMPLETE event, and replay events (src/postgres/quant-comparison.sql,
// src/postgres/comparison-store.js), proven on a throwaway PostgreSQL cluster as a real non-owner LOGIN role with the repo grants. Every row is a
// LABELLED FIXTURE (synthetic, never a research result). Rows are insert-only, so each test uses its own owner and comparisons.
const QR002=INSERT_ONLY_SQLSTATE,QR003=SERIALIZABLE_SQLSTATE,QR004=INSERT_GUARD_SQLSTATE,DENIED='42501',CHECK_VIOLATION='23514',FK_VIOLATION='23503',UNIQUE_VIOLATION='23505',
  SERIALIZATION_FAILURE='40001',INVALID_TEXT='22P02';
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const SPECS='public.quant_comparison_specs',PARTICIPANTS='public.quant_comparison_participants',EVENTS='public.quant_comparison_status_events',REGISTER='public.quant_exposure_register';
const EVALUATIONS='public.quant_comparison_evaluations',BENCHMARKS='public.quant_comparison_benchmarks',OUTCOMES='public.quant_comparison_outcomes',REPLAYS='public.quant_comparison_replay_events';
const RESULT_TABLES=[EVALUATIONS,BENCHMARKS,OUTCOMES,REPLAYS];
const serializable={isolation:'SERIALIZABLE'};
let admin,db,rt,rt2,dl,tr,connectionString,templateName,databaseName,roleName,deleterName,truncaterName,store;
const databases=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const grantPath=fileURLToPath(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url));
const grantScript=async role=>(await fs.readFile(grantPath,'utf8')).replaceAll(":'runtime_role'","'"+role+"'");
const refused=(promise,code)=>assert.rejects(promise,{code});
const refusedBy=(promise,code,constraint)=>assert.rejects(promise,error=>error.code===code&&error.constraint===constraint,'expected '+code+' '+constraint);
const track=pool=>{pools.push(pool);return pool;};
const gate=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(check,label,timeout=10000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw Error('timed out waiting for '+label);
}
class Rollback extends Error {}
/** Runs fn in a transaction that is always rolled back, so a tamper never reaches the committed catalog. */
async function probe(target,fn,options=serializable){
  let value;
  try{await target.transaction(async()=>{value=await fn();throw new Rollback();},options);}catch(error){if(!(error instanceof Rollback))throw error;}
  return value;
}
const rowDigest=async(target,table)=>(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM ${table} t`)).rows[0];
const allRows=async target=>Promise.all([SPECS,PARTICIPANTS,EVENTS,REGISTER,...RESULT_TABLES].map(table=>rowDigest(target,table)));
const inTx=(target,fn)=>target.transaction(fn,serializable);
const insert=(target,table,row)=>inTx(target,()=>target.query(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,index)=>'$'+(index+1)).join(',')}) RETURNING *`,Object.values(row)));
const addEvent=(target,id,seq,status,reason=null)=>inTx(target,()=>target.query('INSERT INTO '+EVENTS+'(comparison_id,seq,status,reason_code) VALUES($1,$2,$3,$4) RETURNING at_ms',[id,seq,status,reason]));
const statusOf=async(target,id)=>(await target.query(`SELECT seq,status FROM ${EVENTS} WHERE comparison_id=$1 ORDER BY seq DESC LIMIT 1`,[id])).rows[0];
const dbClock=async target=>Number((await target.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now);

async function newOwner(label){
  const user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  return user.id;
}
/** A recording wrapper around a database handle: every query is logged, and a test may delay it or make it throw. */
function spy(target,{before=null}={}){
  const log=[];
  const proxy=new Proxy(target,{get(object,property){
    if(property==='query')return async(sql,params)=>{const text=String(sql);log.push(text);if(before)await before(text,log.length);return object.query(sql,params);};
    const value=object[property];
    return typeof value==='function'?value.bind(object):value;
  }});
  return {db:proxy,log};
}

/* ---- fixtures ---- */

const WINDOW0={start_ms:T0,end_ms:T0+1440*MINUTE};
let windowShift=0;
const nextWindow=()=>{windowShift+=1;return {start_ms:WINDOW0.start_ms+windowShift*2*1440*MINUTE,end_ms:WINDOW0.end_ms+windowShift*2*1440*MINUTE};};
function specFor(ids,window){
  const checked=validateSpec({mode:'STANDARDIZED',participants:ids,period:{start_ms:window.start_ms,end_ms:window.end_ms},objective:'qr3-obj-net-return-v1',risk_filter:{max_drawdown_percent:'20'},
    adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},benchmark:'qr3-bh-close-same-cost-v1',
    uncertainty:{method:'qr3-unc-paired-daily-block-bootstrap-v1',seed:'seed-1',resamples:200,block_length:2,confidence:'0.95'}});
  assert.equal(checked.ok,true,JSON.stringify(checked));
  return checked;
}
/** A committed comparison in SPEC_FROZEN. c: {id, owner, ids, spec, specHash, contextKey, window, frozen, seq}. */
async function make(owner,{count=2}={}){
  const window=nextWindow();
  const ids=Array.from({length:count},(_,index)=>'res-'+randomUUID().slice(0,8)+'-'+index);
  const checked=specFor(ids,window);
  const input={owner_id:owner,market:{...MARKET},fixture:true,spec:checked.spec,spec_hash:checked.spec_hash,context_key:hex('context'),
    participants:ids.map((id,index)=>({participant_id:id,source_hash:hex('source-'+id),origin:'FIXTURE',fixture:true,context_key:hex('context'),freeze:{subject:{index},disclosure:{prior_searches:[]}}}))};
  const made=await createComparison(rt,input);
  assert.equal(made.ok,true,JSON.stringify(made));
  return {id:made.comparison_id,owner,ids,spec:checked.spec,specHash:checked.spec_hash,contextKey:hex('context'),window,frozen:made.frozen_at_ms,seq:1};
}
/** A committed comparison in EVALUATING (every later write is strictly later than the freeze). */
async function evaluating(owner,options){
  const c=await make(owner,options);
  await tick();await addEvent(rt,c.id,2,'EVALUATING');c.seq=2;await tick();
  return c;
}
const evalBody=(c,over={})=>({record_comparison_id:c.id,record_spec_hash:c.specHash,window:{start_ms:c.window.start_ms,end_ms:c.window.end_ms},metrics:{net_return:'1.25'},...over});
const evalInput=(c,participant,over={})=>({owner_id:c.owner,comparison_id:c.id,participant_id:participant,spec_hash:c.specHash,body:evalBody(c),...over});
const benchBody=(over={})=>({benchmark_id:BENCHMARK_ID,line:{final_value:'10001.5'},liquidation_line:{label:'SIMULATED_LIQUIDATION',final_value:'9990'},...over});
const benchInput=(c,over={})=>({owner_id:c.owner,comparison_id:c.id,spec_hash:c.specHash,body:benchBody(),...over});
async function withBenchmark(c){
  const written=await writeBenchmark(rt,benchInput(c));
  assert.equal(written.ok,true,JSON.stringify(written));
  await tick();
  return written;
}
/** Writes the evaluation record of every participant and keeps the stored times in c.times: an outcome reports exactly these as created_at_ms. */
async function evaluateAll(c){
  c.times={};
  for(const id of c.ids){const written=await writeEvaluation(rt,evalInput(c,id));assert.equal(written.ok,true,JSON.stringify(written));c.times[id]=written.created_at_ms;}
  await tick();
}
/** The pure outcome decision for the comparison, from [status, metric] per participant. */
function decide(c,list){
  const decided=decideOutcome({mode:'STANDARDIZED',spec:c.spec,spec_hash:c.specHash,context_key:c.contextKey,
    participants:c.ids.map((id,index)=>({id,created_at_ms:c.times?.[id]??c.frozen+1+index,status:list[index][0],primary_metric:list[index][1]??null,reasons:[]})),limitations:[]});
  assert.equal(decided.ok,true,JSON.stringify(decided));
  return decided;
}
const outcomeInput=(c,decided)=>({owner_id:c.owner,comparison_id:c.id,outcome:decided});
/** A raw outcome row (insert columns). over patches the body record, columns patch the columns afterwards. */
function outcomeRecord(c,over={}){
  return {version:'qr3-outcome-v1',mode:'STANDARDIZED',spec_hash:c.specHash,context_key:c.contextKey,outcome:'NO_QUALIFIED_RESULT',participants:c.ids.map(id=>({id,status:'NOT_EVALUATED'})),
    uncertainty:null,only_qualified_participant_id:null,limitations:[],...over};
}
function outcomeRow(c,over={},columns={}){
  const body=canonical(outcomeRecord(c,over));
  return {comparison_id:c.id,outcome:'NO_QUALIFIED_RESULT',spec_hash:c.specHash,context_key:c.contextKey,body_canonical:body,outcome_hash:hash(body),only_qualified_participant_id:null,...columns};
}
function evalRow(c,participant,{body=evalBody(c),columns={}}={}){
  const text=typeof body==='string'?body:canonical(body);
  return {comparison_id:c.id,participant_id:participant,spec_hash:c.specHash,evaluation_run_id:null,body_canonical:text,body_hash:hash(text),...columns};
}
function benchRow(c,{body=benchBody(),columns={}}={}){
  const text=typeof body==='string'?body:canonical(body);
  return {comparison_id:c.id,benchmark_id:BENCHMARK_ID,spec_hash:c.specHash,body_canonical:text,body_hash:hash(text),...columns};
}
/** A comparison that is COMPLETE: benchmark and an outcome written by the store writer. */
async function completed(owner,{count=2,list=null,evaluate=true}={}){
  const c=await evaluating(owner,{count});
  if(evaluate)await evaluateAll(c);
  await withBenchmark(c);
  const decided=decide(c,list??c.ids.map(()=>['DEVELOPMENT_EVIDENCE']));
  const written=await writeOutcome(rt,outcomeInput(c,decided));
  assert.equal(written.ok,true,JSON.stringify(written));
  c.seq=written.complete_seq;
  await tick();
  return {c,decided,written};
}
/**
 * Runs fn inside a rolled-back owner transaction in which the named result guard reads a fixed database clock (ms since the epoch) instead of
 * clock_timestamp(): the real guard body, only the clock is injected, so the equal and the earlier time can be tried on purpose.
 */
async function withClock(functionName,ms,fn){
  return probe(db,async()=>{
    const source=(await db.query("SELECT prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1",[functionName])).rows[0].prosrc;
    assert.ok(source.includes('clock_timestamp()'),functionName+' reads the clock');
    const body=source.replaceAll('clock_timestamp()',`(timestamp with time zone 'epoch' + ${ms} * interval '1 millisecond')`);
    await db.query(`CREATE OR REPLACE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $fnx$${body}$fnx$`);
    return fn();
  });
}

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_s2cr_tpl_'+suffix;databaseName='robot_s2cr_main_'+suffix;
  roleName='robot_s2cr_rt_'+suffix.slice(0,14);deleterName='robot_s2cr_del_'+suffix.slice(0,14);truncaterName='robot_s2cr_trn_'+suffix.slice(0,14);
  for(const name of [roleName,deleterName,truncaterName])await admin.query('CREATE ROLE '+name+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await builder.transaction(async()=>builder.query(await fs.readFile(new URL(name,new URL('../../src/postgres/',import.meta.url)),'utf8')));
    await migrateQuantExposureRegister(builder);
    await migrateQuantComparison(builder);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  connectionString=urlOf(databaseName);
  db=track(new PostgresDatabase({connectionString,max:8}));
  store=new Store(db);
  for(const role of [roleName,deleterName,truncaterName])await db.query(await grantScript(role));
  for(const table of [SPECS,PARTICIPANTS,EVENTS,...RESULT_TABLES]){
    await db.query(`GRANT DELETE ON TABLE ${table} TO ${deleterName}`);await db.query(`GRANT TRUNCATE ON TABLE ${table} TO ${truncaterName}`);
  }
  rt=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:6}));rt2=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:6}));
  dl=track(new PostgresDatabase({connectionString:urlOf(databaseName,deleterName),max:2}));tr=track(new PostgresDatabase({connectionString:urlOf(databaseName,truncaterName),max:2}));
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    for(const name of [...databases,databaseName,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    for(const name of [roleName,deleterName,truncaterName])await admin.query('DROP ROLE IF EXISTS '+name).catch(()=>{});
    await admin.close();
  }
});

/* ---- 1. evaluation records ---- */

test('evaluation: a record is stored under a database-clock time strictly after the freeze; a supplied time is ignored; the read returns the stored bytes; research rows stay',async()=>{
  const owner=await newOwner('s2cr-eval');
  const researchBefore=[await rowDigest(db,'public.users'),await rowDigest(db,'public.quant_jobs'),await rowDigest(db,'public.quant_job_steps')];
  const c=await evaluating(owner,{count:3});
  const clockBefore=await dbClock(db);
  const written=[];
  for(const [index,id] of c.ids.entries())written.push(await writeEvaluation(rt,evalInput(c,id,{evaluation_run_id:'eval-run-'+index,body:evalBody(c,{metrics:{net_return:'1.25',index}})})));
  const clockAfter=await dbClock(db);
  assert.ok(written.every(item=>item.ok&&item.attempts===1),JSON.stringify(written));
  assert.ok(written.every(item=>item.created_at_ms>=clockBefore&&item.created_at_ms<=clockAfter&&item.created_at_ms>c.frozen),'the time is the database clock, strictly after the freeze');
  const rows=(await db.query(`SELECT * FROM ${EVALUATIONS} WHERE comparison_id=$1 ORDER BY participant_id COLLATE "C"`,[c.id])).rows;
  assert.equal(rows.length,3);
  for(const row of rows){
    const index=c.ids.indexOf(row.participant_id);
    assert.deepEqual([row.spec_hash,row.evaluation_run_id,row.body_canonical,row.body_hash],[c.specHash,'eval-run-'+index,canonical(evalBody(c,{metrics:{net_return:'1.25',index}})),hash(row.body_canonical)]);
  }
  // a supplied created_at_ms is overwritten by the guard (raw insert by the runtime role, rolled back)
  const other=await evaluating(owner);
  const stamped=await probe(rt,async()=>Number((await rt.query(`INSERT INTO ${EVALUATIONS}(comparison_id,participant_id,spec_hash,body_canonical,body_hash,created_at_ms) VALUES($1,$2,$3,$4,$5,1) RETURNING created_at_ms`,
    Object.values(evalRow(other,other.ids[0])).filter((_,position)=>position!==3))).rows[0].created_at_ms));
  assert.ok(stamped>other.frozen&&stamped>1e12,'the supplied time 1 was replaced: '+stamped);
  // the read
  const view=await readComparisonResults(rt,{owner_id:owner,comparison_id:c.id});
  assert.equal(view.ok,true,JSON.stringify(view));
  assert.deepEqual(view.evaluations.map(item=>item.participant_id),[...c.ids].sort());
  for(const item of view.evaluations){
    assert.deepEqual([item.record_comparison_id,item.record_spec_hash,item.spec_hash,item.body.window],[c.id,c.specHash,c.specHash,c.window]);
    assert.ok(item.created_at_ms>view.frozen_at_ms,'F3: strictly later than the freeze');
  }
  assert.deepEqual([view.benchmark,view.outcome,view.replay_events,view.spec_hash,view.frozen_at_ms],[null,null,[],c.specHash,c.frozen]);
  assert.deepEqual(await statusOf(db,c.id),{seq:2,status:'EVALUATING'},'an evaluation record changes no status');
  assert.deepEqual([await rowDigest(db,'public.users'),await rowDigest(db,'public.quant_jobs'),await rowDigest(db,'public.quant_job_steps')],researchBefore,'research and account rows are byte-identical');
});

test('evaluation (F3): every guard and CHECK refusal, by guard name; nothing is stored by a refused write',async()=>{
  const owner=await newOwner('s2cr-eval-guard');
  const c=await evaluating(owner),p=c.ids[0];
  const guard=name=>[QR004,'quant_comparison_'+name];
  const check=name=>[CHECK_VIOLATION,'quant_comparison_evaluations_'+name];
  const bigBody=canonical(evalBody(c,{pad:'x'.repeat(MAX_EVALUATION_BYTES)}));
  const wrongWindow=patch=>evalBody(c,{window:{...c.window,...patch}});
  const cases=[
    ['spec_hash column of another spec',evalRow(c,p,{columns:{spec_hash:hex('other')}}),...guard('eval_freeze_order')],
    ['record_comparison_id of another comparison',evalRow(c,p,{body:evalBody(c,{record_comparison_id:'another-comparison'})}),...guard('eval_freeze_order')],
    ['record_spec_hash of another spec',evalRow(c,p,{body:evalBody(c,{record_spec_hash:hex('other')})}),...guard('eval_freeze_order')],
    ['window start differs',evalRow(c,p,{body:wrongWindow({start_ms:c.window.start_ms+MINUTE})}),...guard('eval_window')],
    ['window end differs',evalRow(c,p,{body:wrongWindow({end_ms:c.window.end_ms-MINUTE})}),...guard('eval_window')],
    ['unknown comparison',evalRow(c,p,{columns:{comparison_id:'no-such-comparison'}}),...guard('eval_spec')],
    ['a participant of no such comparison',evalRow(c,'not-a-participant'),FK_VIOLATION,'quant_comparison_evaluations_participant_fkey'],
    ['body not JSON',evalRow(c,p,{body:'not json'}),INVALID_TEXT,undefined],
    ['body is an array',evalRow(c,p,{body:'[]'}),...check('body_check')],
    ['body without record_comparison_id',evalRow(c,p,{body:{record_spec_hash:c.specHash,window:c.window}}),...check('body_check')],
    ['record_spec_hash not a string',evalRow(c,p,{body:evalBody(c,{record_spec_hash:7})}),...check('body_check')],
    ['body without a window',evalRow(c,p,{body:{record_comparison_id:c.id,record_spec_hash:c.specHash}}),...check('body_check')],
    ['window start as a string',evalRow(c,p,{body:wrongWindow({start_ms:String(c.window.start_ms)})}),...check('body_check')],
    ['body hash of other text',evalRow(c,p,{columns:{body_hash:hex('other')}}),...check('body_digest_check')],
    ['body over 4 MiB',evalRow(c,p,{body:bigBody}),...check('body_size_check')],
    ['invalid evaluation run id',evalRow(c,p,{columns:{evaluation_run_id:'-bad id'}}),...check('run_id_check')]];
  const before=await allRows(db);
  for(const [label,row,code,constraint] of cases){
    await assert.rejects(insert(rt,EVALUATIONS,row),error=>error.code===code&&(constraint===undefined||error.constraint===constraint),label);
  }
  assert.deepEqual(await allRows(db),before,'nothing was stored');
  // the body CHECK itself ties record_comparison_id and record_spec_hash to the columns, also when the guard is lifted (planted by the table owner, rolled back)
  for(const [label,body] of [['record_comparison_id of another comparison',evalBody(c,{record_comparison_id:'another-comparison'})],['record_spec_hash differs from the column',evalBody(c,{record_spec_hash:hex('other')})]]){
    const planted={...evalRow(c,p,{body}),created_at_ms:c.frozen+1};
    await assert.rejects(probe(db,async()=>{
      await db.query('ALTER TABLE public.quant_comparison_evaluations DISABLE TRIGGER quant_comparison_evaluations_guard');
      await db.query(`INSERT INTO ${EVALUATIONS}(${Object.keys(planted).join(',')}) VALUES(${Object.keys(planted).map((_,index)=>'$'+(index+1)).join(',')})`,Object.values(planted));
    }),error=>error.code===CHECK_VIOLATION&&error.constraint==='quant_comparison_evaluations_body_check',label);
  }
  // the runtime role stamps and the guard accepts the same row once it is right (control)
  assert.equal((await insert(rt,EVALUATIONS,evalRow(c,p))).rowCount,1);
  // a second record for the same participant is a unique violation
  await refused(insert(rt,EVALUATIONS,evalRow(c,p)),UNIQUE_VIOLATION);
});

test('evaluation (F3): the comparison must be EVALUATING; an equal or earlier database time than the freeze is refused (clock injected into the real guard)',async()=>{
  const owner=await newOwner('s2cr-eval-state');
  // SPEC_FROZEN, then each terminal status: no record
  const frozen=await make(owner);await tick();
  await refusedBy(insert(rt,EVALUATIONS,evalRow(frozen,frozen.ids[0])),QR004,'quant_comparison_eval_status');
  for(const [status,reason] of [['FAILED','EVALUATION_ERROR'],['CANCELLED',null]]){
    const c=await evaluating(owner);
    await addEvent(rt,c.id,3,status,reason);await tick();
    await refusedBy(insert(rt,EVALUATIONS,evalRow(c,c.ids[0])),QR004,'quant_comparison_eval_status');
    assert.equal((await writeEvaluation(rt,evalInput(c,c.ids[0]))).detail,'quant_comparison_eval_status');
  }
  const done=(await completed(owner)).c;
  await refusedBy(insert(rt,EVALUATIONS,evalRow(done,done.ids[0])),QR004,'quant_comparison_eval_status');
  // the time rule: the injected clock equals the freeze, is earlier than the freeze, is one millisecond later
  const c=await evaluating(owner);
  const row=evalRow(c,c.ids[0]);
  const columns=Object.keys(row);
  const attempt=ms=>withClock('quant_comparison_guard_evaluation',ms,()=>db.query(`INSERT INTO ${EVALUATIONS}(${columns.join(',')}) VALUES(${columns.map((_,index)=>'$'+(index+1)).join(',')}) RETURNING created_at_ms`,Object.values(row)));
  await refusedBy(attempt(c.frozen),QR004,'quant_comparison_eval_freeze_order');
  await refusedBy(attempt(c.frozen-1),QR004,'quant_comparison_eval_freeze_order');
  await refusedBy(attempt(c.frozen-3600000),QR004,'quant_comparison_eval_freeze_order');
  assert.equal(Number((await attempt(c.frozen+1)).rows[0].created_at_ms),c.frozen+1,'one millisecond later is accepted and stamped as is');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${EVALUATIONS} WHERE comparison_id=$1`,[c.id])).rows[0].n,0,'every injected attempt was rolled back');
});

test('evaluation writer: ownership, input checks, mapping by guard name, duplicates, bounded retry',async()=>{
  const owner=await newOwner('s2cr-eval-writer'),other=await newOwner('s2cr-eval-writer-other');
  const c=await evaluating(owner),p=c.ids[0];
  // absent, foreign and malformed ids answer with one object
  for(const input of [{...evalInput(c,p),comparison_id:'no-such-comparison'},{...evalInput(c,p),owner_id:other},{...evalInput(c,p),comparison_id:'bad id; DROP TABLE'},{...evalInput(c,p),owner_id:undefined}])
    assert.deepEqual(await writeEvaluation(rt,input),{ok:false,code:'NOT_FOUND',detail:null});
  // refusals that need no database
  const untouchable={isTransaction:false,query(){throw Error('query on a refused request');},transaction(){throw Error('transaction on a refused request');}};
  const pure=[[evalInput(c,'-bad id'),CODES.INVALID_RUN_ID],[evalInput(c,p,{spec_hash:'xyz'}),CODES.INVALID_FIELDS],[evalInput(c,p,{evaluation_run_id:'-bad'}),CODES.INVALID_FIELDS],
    [evalInput(c,p,{body:'text'}),CODES.INVALID_FIELDS],[evalInput(c,p,{body:[1]}),CODES.INVALID_FIELDS],[evalInput(c,p,{body:evalBody(c,{pad:'x'.repeat(MAX_EVALUATION_BYTES)})}),CODES.INVALID_FIELDS]];
  for(const [input,code] of pure)assert.equal((await writeEvaluation(untouchable,input)).code,code);
  await assert.rejects(writeEvaluation({isTransaction:true,query(){},transaction(){}},evalInput(c,p)),/own transaction/);
  // mapped refusals
  const mapped=[
    ['another spec hash',evalInput(c,p,{spec_hash:hex('other')}),CODES.QR3_RESULT_PREDATES_SPEC,'quant_comparison_eval_freeze_order'],
    ['another record comparison id',evalInput(c,p,{body:evalBody(c,{record_comparison_id:'x'})}),CODES.QR3_RESULT_PREDATES_SPEC,'quant_comparison_eval_freeze_order'],
    ['another window',evalInput(c,p,{body:evalBody(c,{window:{start_ms:c.window.start_ms,end_ms:c.window.end_ms-MINUTE}})}),CODES.QR3_INTEGRITY_FAILED,'quant_comparison_eval_window'],
    ['no record_spec_hash',evalInput(c,p,{body:{record_comparison_id:c.id,window:c.window}}),CODES.QR3_INTEGRITY_FAILED,'quant_comparison_evaluations_body_check'],
    ['a participant of no such comparison',evalInput(c,'not-a-participant'),CODES.INVALID_FIELDS,'quant_comparison_evaluations_participant_fkey']];
  for(const [label,input,code,detail] of mapped){const answer=await writeEvaluation(rt,input);assert.deepEqual([answer.ok,answer.code,answer.detail],[false,code,detail],label);}
  const first=await writeEvaluation(rt,evalInput(c,p));
  assert.equal(first.ok,true);
  assert.deepEqual(await writeEvaluation(rt,evalInput(c,p)),{ok:false,code:CODES.INVALID_FIELDS,detail:'ALREADY_RECORDED'});
  // two concurrent writers for one participant: exactly one wins, the other is ALREADY_RECORDED
  const q=c.ids[1];
  const both=await Promise.all([writeEvaluation(rt,evalInput(c,q)),writeEvaluation(rt2,evalInput(c,q))]);
  assert.deepEqual(both.map(item=>item.ok).sort(),[false,true]);
  assert.deepEqual(both.find(item=>!item.ok),{ok:false,code:CODES.INVALID_FIELDS,detail:'ALREADY_RECORDED'});
  // bounded retry: the owner read and the insert are rerun in a new transaction; the 40001 is thrown when the retries are used up
  const serializationFailure=()=>Object.assign(Error('could not serialize access'),{code:SERIALIZATION_FAILURE});
  const fresh=await evaluating(owner);
  let failures=2;
  const flaky=spy(rt,{before:async sql=>{if(/^INSERT INTO public.quant_comparison_evaluations/.test(sql)&&failures>0){failures-=1;throw serializationFailure();}}});
  const retried=await writeEvaluation(flaky.db,evalInput(fresh,fresh.ids[0]));
  assert.deepEqual([retried.ok,retried.attempts],[true,3]);
  assert.equal(flaky.log.filter(sql=>/FROM public.quant_comparison_specs/.test(sql)).length,3,'the owner read is rerun by each attempt');
  assert.equal(MAX_RETRIES,3);
  const hopeless=spy(rt,{before:async sql=>{if(/^INSERT INTO public.quant_comparison_evaluations/.test(sql))throw serializationFailure();}});
  const before=await allRows(db);
  await assert.rejects(writeEvaluation(hopeless.db,evalInput(fresh,fresh.ids[1])),error=>error.code===SERIALIZATION_FAILURE);
  assert.equal(hopeless.log.filter(sql=>/^INSERT INTO public.quant_comparison_evaluations/.test(sql)).length,4);
  const hard=spy(rt,{before:async sql=>{if(/^INSERT INTO public.quant_comparison_evaluations/.test(sql))throw Object.assign(Error('boom'),{code:'XX000'});}});
  await assert.rejects(writeEvaluation(hard.db,evalInput(fresh,fresh.ids[1])),error=>error.code==='XX000');
  assert.equal(hard.log.filter(sql=>/^INSERT INTO public.quant_comparison_evaluations/.test(sql)).length,1,'another failure is not retried');
  assert.deepEqual(await allRows(db),before);
});

/* ---- 2. benchmarks ---- */

test('benchmark: one row per comparison under the same F3 rules; a null line with its reason is stored as given',async()=>{
  const owner=await newOwner('s2cr-bench');
  const c=await evaluating(owner);
  const written=await writeBenchmark(rt,benchInput(c));
  assert.equal(written.ok,true,JSON.stringify(written));
  assert.ok(written.created_at_ms>c.frozen);
  const row=(await db.query(`SELECT * FROM ${BENCHMARKS} WHERE comparison_id=$1`,[c.id])).rows[0];
  assert.deepEqual([row.benchmark_id,row.spec_hash,row.body_canonical,row.body_hash,Number(row.created_at_ms)],[BENCHMARK_ID,c.specHash,canonical(benchBody()),hash(canonical(benchBody())),written.created_at_ms]);
  assert.deepEqual(await writeBenchmark(rt,benchInput(c)),{ok:false,code:CODES.INVALID_FIELDS,detail:'ALREADY_RECORDED'});
  // RC-C20 and B6: a null line with a reason code is a stored row, not a refusal
  const none=await evaluating(owner);
  const nullLine={benchmark_id:BENCHMARK_ID,line:null,reason:CODES.QR3_METRIC_UNAVAILABLE,detail:'NO_UNITS_AFFORDABLE'};
  assert.equal((await writeBenchmark(rt,benchInput(none,{body:nullLine}))).ok,true);
  const view=await readComparisonResults(rt,{owner_id:owner,comparison_id:none.id});
  assert.deepEqual([view.benchmark.body,view.benchmark.benchmark_id,view.benchmark.spec_hash],[nullLine,BENCHMARK_ID,none.specHash]);
  assert.ok(view.benchmark.created_at_ms>view.frozen_at_ms);
  // ownership and input checks
  for(const input of [{...benchInput(c),comparison_id:'no-such-comparison'},{...benchInput(c),owner_id:await newOwner('s2cr-bench-other')}])assert.deepEqual(await writeBenchmark(rt,input),{ok:false,code:'NOT_FOUND',detail:null});
  assert.equal((await writeBenchmark(rt,benchInput(c,{body:benchBody({benchmark_id:'other'})}))).detail,'BENCHMARK_ID');
  assert.equal((await writeBenchmark(rt,benchInput(c,{body:'text'}))).detail,'BODY');
  assert.equal((await writeBenchmark(rt,benchInput(c,{spec_hash:'xyz'}))).detail,'SPEC_HASH');
});

test('benchmark: guard and CHECK refusals by name; an equal or earlier database time than the freeze is refused',async()=>{
  const owner=await newOwner('s2cr-bench-guard');
  const c=await evaluating(owner);
  const frozen=await make(owner);await tick();
  const guard=name=>[QR004,'quant_comparison_'+name];
  const check=name=>[CHECK_VIOLATION,'quant_comparison_benchmarks_'+name];
  const cases=[
    ['spec hash of another spec',c,benchRow(c,{columns:{spec_hash:hex('other')}}),...guard('benchmark_freeze_order')],
    ['unknown comparison',c,benchRow(c,{columns:{comparison_id:'no-such-comparison'}}),...guard('benchmark_spec')],
    ['SPEC_FROZEN comparison',frozen,benchRow(frozen),...guard('benchmark_status')],
    ['another benchmark id',c,benchRow(c,{columns:{benchmark_id:'other'}}),...check('benchmark_id_check')],
    ['body benchmark id differs',c,benchRow(c,{body:{benchmark_id:'other'}}),...check('body_check')],
    ['body is an array',c,benchRow(c,{body:'[]'}),...check('body_check')],
    ['body hash of other text',c,benchRow(c,{columns:{body_hash:hex('other')}}),...check('body_digest_check')],
    ['body over 256 KiB',c,benchRow(c,{body:{benchmark_id:BENCHMARK_ID,pad:'x'.repeat(270000)}}),...check('body_size_check')],
    ['body not JSON',c,benchRow(c,{body:'not json'}),INVALID_TEXT,undefined]];
  const before=await allRows(db);
  for(const [label,target,row,code,constraint] of cases){
    await assert.rejects(insert(rt,BENCHMARKS,row),error=>error.code===code&&(constraint===undefined||error.constraint===constraint),label);
  }
  assert.deepEqual(await allRows(db),before,'nothing was stored');
  for(const [status,reason] of [['FAILED','EVALUATION_ERROR'],['CANCELLED',null]]){
    const ended=await evaluating(owner);await addEvent(rt,ended.id,3,status,reason);await tick();
    await refusedBy(insert(rt,BENCHMARKS,benchRow(ended)),QR004,'quant_comparison_benchmark_status');
    assert.equal((await writeBenchmark(rt,benchInput(ended))).detail,'quant_comparison_benchmark_status');
  }
  const row=benchRow(c),columns=Object.keys(row);
  const attempt=ms=>withClock('quant_comparison_guard_benchmark',ms,()=>db.query(`INSERT INTO ${BENCHMARKS}(${columns.join(',')}) VALUES(${columns.map((_,index)=>'$'+(index+1)).join(',')}) RETURNING created_at_ms`,Object.values(row)));
  await refusedBy(attempt(c.frozen),QR004,'quant_comparison_benchmark_freeze_order');
  await refusedBy(attempt(c.frozen-1),QR004,'quant_comparison_benchmark_freeze_order');
  assert.equal(Number((await attempt(c.frozen+1)).rows[0].created_at_ms),c.frozen+1);
  assert.equal((await writeBenchmark(rt,benchInput(c,{spec_hash:hex('other')}))).code,CODES.QR3_RESULT_PREDATES_SPEC);
});

/* ---- 3. outcomes ---- */

test('outcome: the four outcome values are stored with the COMPLETE event in one transaction; the row carries the hash of the decided record',async()=>{
  const owner=await newOwner('s2cr-outcome');
  const shapes=[
    ['QUALIFIED_TIE',[['ELIGIBLE_QUALIFIED','1.20'],['ELIGIBLE_QUALIFIED','1.10']],null],
    ['NO_QUALIFIED_RESULT',[['DEVELOPMENT_EVIDENCE'],['FILTERED_RISK']],null],
    ['NO_QUALIFIED_RESULT',[['ELIGIBLE_QUALIFIED','1.20'],['INADEQUATE_SAMPLE']],0],
    ['INADEQUATE_EVIDENCE',[['INADEQUATE_SAMPLE'],['INADEQUATE_SAMPLE']],null]];
  for(const [expected,list,only] of shapes){
    const c=await evaluating(owner);
    await withBenchmark(c);
    await evaluateAll(c);
    const decided=decide(c,list);
    assert.equal(decided.outcome,expected);
    const evaluatingAt=Number((await db.query(`SELECT at_ms FROM ${EVENTS} WHERE comparison_id=$1 AND seq=2`,[c.id])).rows[0].at_ms);
    const written=await writeOutcome(rt,outcomeInput(c,decided));
    assert.equal(written.ok,true,JSON.stringify(written));
    assert.deepEqual([written.outcome,written.outcome_hash,written.complete_seq,written.attempts],[expected,decided.outcome_hash,3,1]);
    assert.ok(written.created_at_ms>c.frozen&&written.complete_at_ms>evaluatingAt,'database times, strictly after the freeze and the previous event');
    const row=(await db.query(`SELECT * FROM ${OUTCOMES} WHERE comparison_id=$1`,[c.id])).rows[0];
    const record=JSON.parse(row.body_canonical);
    assert.deepEqual([row.outcome,row.spec_hash,row.context_key,row.outcome_hash,row.only_qualified_participant_id,hash(row.body_canonical)],
      [expected,c.specHash,c.contextKey,decided.outcome_hash,only===null?null:c.ids[only],decided.outcome_hash]);
    assert.equal(row.body_canonical,canonical(record));
    assert.deepEqual([record.version,record.mode,record.outcome,record.participants.map(item=>item.id).sort()],['qr3-outcome-v1','STANDARDIZED',expected,[...c.ids].sort()]);
    assert.deepEqual(await statusOf(db,c.id),{seq:3,status:'COMPLETE'});
    const view=await readComparison(rt,{owner_id:owner,comparison_id:c.id});
    assert.deepEqual([view.status.status,view.events.map(item=>item.status)],['COMPLETE',['SPEC_FROZEN','EVALUATING','COMPLETE']]);
    const results=await readComparisonResults(rt,{owner_id:owner,comparison_id:c.id});
    assert.deepEqual([results.outcome.outcome,results.outcome.outcome_hash,results.outcome.record.participants.length,results.outcome.context_key],[expected,decided.outcome_hash,2,c.contextKey]);
    assert.equal(hash(canonical(results.outcome.record)),results.outcome.outcome_hash,'I3: the hash is the hash of the canonical record');
  }
  // a ranked outcome (the pure decision needs daily returns; this row is a synthetic record of the same shape)
  const ranked=await evaluating(owner);await withBenchmark(ranked);await evaluateAll(ranked);
  const record=outcomeRecord(ranked,{outcome:'QUALIFIED_RANKING',participants:ranked.ids.map((id,index)=>({id,created_at_ms:ranked.times[id],rank:index+1,status:'ELIGIBLE_QUALIFIED'}))});
  const synthetic={ok:true,...record,outcome_hash:hash(canonical(record))};
  const written=await writeOutcome(rt,outcomeInput(ranked,synthetic));
  assert.deepEqual([written.ok,written.outcome],[true,'QUALIFIED_RANKING']);
});

test('outcome: guard refusals by name (status, benchmark, spec hash, participants), CHECK refusals, and the writer mapping',async()=>{
  const owner=await newOwner('s2cr-outcome-guard');
  const c=await evaluating(owner);
  const guard=name=>[QR004,'quant_comparison_'+name];
  const check=name=>[CHECK_VIOLATION,'quant_comparison_outcomes_'+name];
  // no benchmark yet
  await refusedBy(insert(rt,OUTCOMES,outcomeRow(c)),...guard('outcome_order'));
  assert.equal((await writeOutcome(rt,outcomeInput(c,decide(c,[['DEVELOPMENT_EVIDENCE'],['DEVELOPMENT_EVIDENCE']])))).detail,'quant_comparison_outcome_order');
  await withBenchmark(c);
  const frozen=await make(owner);await tick();
  const first=c.ids[0];
  const cases=[
    ['SPEC_FROZEN comparison',frozen,outcomeRow(frozen),...guard('outcome_status')],
    ['unknown comparison',c,outcomeRow(c,{},{comparison_id:'no-such-comparison'}),...guard('outcome_spec')],
    ['spec hash of another spec',c,outcomeRow(c,{spec_hash:hex('other')},{spec_hash:hex('other')}),...guard('outcome_spec_hash')],
    ['context key of another context',c,outcomeRow(c,{context_key:hex('other')},{context_key:hex('other')}),...guard('outcome_spec_hash')],
    ['one participant missing',c,outcomeRow(c,{participants:[{id:first}]}),...guard('outcome_order')],
    ['one participant too many',c,outcomeRow(c,{participants:[...c.ids,'stranger'].map(id=>({id}))}),...guard('outcome_order')],
    ['a participant twice',c,outcomeRow(c,{participants:[{id:first},{id:first}]}),...guard('outcome_order')],
    ['participants as text ids',c,outcomeRow(c,{participants:c.ids}),...guard('outcome_order')],
    ['participant id as a number',c,outcomeRow(c,{participants:[{id:1},{id:2}]}),...guard('outcome_order')],
    ['participants not an array',c,outcomeRow(c,{participants:'ab'}),...check('body_check')],
    ['participants null',c,outcomeRow(c,{participants:null}),...check('body_check')],
    ['outcome value of another mode',c,outcomeRow(c,{outcome:'ACTUAL_HISTORY_SIDE_BY_SIDE'},{outcome:'ACTUAL_HISTORY_SIDE_BY_SIDE'}),...check('outcome_check')],
    ['outcome value not in version 1',c,outcomeRow(c,{outcome:'SINGLE_QUALIFIED_RESULT'},{outcome:'SINGLE_QUALIFIED_RESULT'}),...check('outcome_check')],
    ['body outcome differs from the column',c,outcomeRow(c,{outcome:'QUALIFIED_TIE'}),...check('body_check')],
    ['body version differs',c,outcomeRow(c,{version:'qr3-outcome-v0'}),...check('body_check')],
    ['body mode differs',c,outcomeRow(c,{mode:'ACTUAL_BOT'}),...check('body_check')],
    ['body spec hash differs from the column',c,outcomeRow(c,{spec_hash:hex('other')}),...check('body_check')],
    ['body context key differs from the column',c,outcomeRow(c,{context_key:hex('other')}),...check('body_check')],
    ['body without a context key',c,outcomeRow(c,{context_key:null}),...check('body_check')],
    ['body only-qualified id differs from the column',c,outcomeRow(c,{only_qualified_participant_id:first}),...check('body_check')],
    ['only-qualified id with a ranked outcome',c,outcomeRow(c,{outcome:'QUALIFIED_TIE',only_qualified_participant_id:first},{outcome:'QUALIFIED_TIE',only_qualified_participant_id:first}),...check('only_qualified_check')],
    ['only-qualified id of no participant',c,outcomeRow(c,{only_qualified_participant_id:'stranger'},{only_qualified_participant_id:'stranger'}),FK_VIOLATION,'quant_comparison_outcomes_only_qualified_fkey'],
    ['outcome hash of other text',c,outcomeRow(c,{},{outcome_hash:hex('other')}),...check('body_digest_check')],
    ['body over 256 KiB',c,outcomeRow(c,{pad:'x'.repeat(270000)}),...check('body_size_check')],
    ['body not JSON',c,{...outcomeRow(c),body_canonical:'not json',outcome_hash:hash('not json')},INVALID_TEXT,undefined]];
  const before=await allRows(db);
  for(const [label,target,row,code,constraint] of cases){
    await assert.rejects(inTx(rt,()=>rt.query(`INSERT INTO ${OUTCOMES}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,index)=>'$'+(index+1)).join(',')})`,Object.values(row))),
      error=>error.code===code&&(constraint===undefined||error.constraint===constraint),label);
  }
  assert.deepEqual(await allRows(db),before,'nothing was stored');
  // writer mapping (no database for the pure ones)
  const untouchable={isTransaction:false,query(){throw Error('query on a refused request');},transaction(){throw Error('transaction on a refused request');}};
  const decided=decide(c,[['DEVELOPMENT_EVIDENCE'],['DEVELOPMENT_EVIDENCE']]);
  assert.equal((await writeOutcome(untouchable,outcomeInput(c,{...decided,outcome_hash:hex('other')}))).detail,'OUTCOME_HASH');
  assert.equal((await writeOutcome(untouchable,outcomeInput(c,{ok:false,code:'X'}))).code,CODES.INVALID_FIELDS);
  assert.equal((await writeOutcome(untouchable,outcomeInput(c,{...decided,spec_hash:null,outcome_hash:undefined}))).code,CODES.INVALID_FIELDS);
  const otherSpec=await writeOutcome(rt,outcomeInput(c,{...decided,spec_hash:hex('other'),outcome_hash:undefined}));
  assert.deepEqual([otherSpec.code,otherSpec.detail],[CODES.QR3_SPEC_IMMUTABLE,'quant_comparison_outcome_spec_hash']);
  const strangers=await writeOutcome(rt,outcomeInput(c,{...decided,participants:[{id:first}],outcome_hash:undefined}));
  assert.deepEqual([strangers.code,strangers.detail],[CODES.QR3_INTEGRITY_FAILED,'quant_comparison_outcome_order']);
  assert.deepEqual(await writeOutcome(rt,{...outcomeInput(c,decided),owner_id:await newOwner('s2cr-outcome-other')}),{ok:false,code:'NOT_FOUND',detail:null});
  assert.deepEqual(await allRows(db),before,'no refused writer call stored anything');
  // the time rule on the real guard with an injected clock
  const row=outcomeRow(c),columns=Object.keys(row);
  const attempt=ms=>withClock('quant_comparison_guard_outcome',ms,()=>db.query(`INSERT INTO ${OUTCOMES}(${columns.join(',')}) VALUES(${columns.map((_,index)=>'$'+(index+1)).join(',')}) RETURNING created_at_ms`,Object.values(row)));
  await refusedBy(attempt(c.frozen),QR004,'quant_comparison_outcome_freeze_order');
  await refusedBy(attempt(c.frozen-1),QR004,'quant_comparison_outcome_freeze_order');
  assert.equal(Number((await attempt(c.frozen+1)).rows[0].created_at_ms),c.frozen+1);
  // after the outcome the comparison is COMPLETE: no second outcome, no later evaluation, benchmark or status
  await evaluateAll(c);
  const real=decide(c,[['DEVELOPMENT_EVIDENCE'],['DEVELOPMENT_EVIDENCE']]);
  const done=await writeOutcome(rt,outcomeInput(c,real));
  assert.equal(done.ok,true,JSON.stringify(done));
  const second=await writeOutcome(rt,outcomeInput(c,real));
  assert.deepEqual([second.ok,second.code,second.detail],[false,STORE_CODES.NOT_CANCELLABLE,'quant_comparison_outcome_status'],'a writer that lost to COMPLETE is a status refusal, not an integrity failure');
  const late=await writeEvaluation(rt,evalInput(c,first));
  assert.deepEqual([late.ok,late.code,late.detail],[false,STORE_CODES.NOT_CANCELLABLE,'quant_comparison_eval_status']);
  await refusedBy(insert(rt,OUTCOMES,outcomeRow(c)),QR004,'quant_comparison_outcome_status');
  await refusedBy(insert(rt,EVALUATIONS,evalRow(c,first)),QR004,'quant_comparison_eval_status');
  await refusedBy(addEvent(rt,c.id,4,'CANCELLED'),QR004,'quant_comparison_status_transition');
  const lateBenchmark=await writeBenchmark(rt,benchInput(c));
  assert.deepEqual([lateBenchmark.code,lateBenchmark.detail],[STORE_CODES.NOT_CANCELLABLE,'quant_comparison_benchmark_status']);
});

test('outcome: the outcome row and the COMPLETE event are one unit (commit check, SET CONSTRAINTS, savepoints, missing outcome)',async()=>{
  const owner=await newOwner('s2cr-outcome-atomic');
  const prepared=async()=>{const c=await evaluating(owner);await withBenchmark(c);return c;};
  const outcomeSql=row=>[`INSERT INTO ${OUTCOMES}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,index)=>'$'+(index+1)).join(',')})`,Object.values(row)];
  const complete=(c,target=rt)=>target.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'COMPLETE')`,[c.id]);
  // an outcome without the COMPLETE event does not commit
  let c=await prepared();
  await refusedBy(inTx(rt,()=>rt.query(...outcomeSql(outcomeRow(c)))),QR004,'quant_comparison_outcome_complete');
  // SET CONSTRAINTS ALL IMMEDIATE right after the outcome insert fails closed: the COMPLETE event is not there yet
  await refusedBy(inTx(rt,async()=>{await rt.query(...outcomeSql(outcomeRow(c)));await rt.query('SET CONSTRAINTS ALL IMMEDIATE');await complete(c);}),QR004,'quant_comparison_outcome_complete');
  // a COMPLETE event without an outcome row is refused by the status guard
  await refusedBy(inTx(rt,()=>complete(c)),QR004,'quant_comparison_status_transition');
  // an outcome rolled back inside a savepoint leaves no outcome for the COMPLETE event
  await refusedBy(inTx(rt,async()=>{
    await rt.query('SAVEPOINT o');await rt.query(...outcomeSql(outcomeRow(c)));await rt.query('ROLLBACK TO SAVEPOINT o');await complete(c);
  }),QR004,'quant_comparison_status_transition');
  assert.deepEqual(await statusOf(db,c.id),{seq:2,status:'EVALUATING'},'nothing of the refused attempts stayed');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${OUTCOMES} WHERE comparison_id=$1`,[c.id])).rows[0].n,0);
  // outcome then COMPLETE in one transaction commits, also after SET CONSTRAINTS ALL IMMEDIATE placed after both rows and with subtransactions
  await inTx(rt,async()=>{await rt.query(...outcomeSql(outcomeRow(c)));await complete(c);await rt.query('SET CONSTRAINTS ALL IMMEDIATE');});
  assert.deepEqual(await statusOf(db,c.id),{seq:3,status:'COMPLETE'});
  c=await prepared();
  await inTx(rt,async()=>{
    await rt.query('SAVEPOINT o');await rt.query(...outcomeSql(outcomeRow(c)));await rt.query('RELEASE SAVEPOINT o');
    await rt.query('SAVEPOINT s');await complete(c);await rt.query('RELEASE SAVEPOINT s');
  });
  assert.deepEqual(await statusOf(db,c.id),{seq:3,status:'COMPLETE'},'rows written inside released savepoints belong to the transaction');
  assert.equal((await classifyQuantComparison(db)).state,'INSTALLED');
});

test('outcome: a cancel and an outcome race for the same status key; one terminal event wins and a lost outcome leaves nothing behind',async()=>{
  const owner=await newOwner('s2cr-outcome-race');
  const lockWaiters=async()=>(await db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND state='active'")).rows[0].n;
  // 1. the outcome transaction holds the key first: the cancel waits and then fails; the outcome stays
  let c=await evaluating(owner);await withBenchmark(c);
  let entered=gate(),release=gate();
  const writer=inTx(rt,async()=>{
    const row=outcomeRow(c);
    await rt.query(`INSERT INTO ${OUTCOMES}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,index)=>'$'+(index+1)).join(',')})`,Object.values(row));
    await rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'COMPLETE')`,[c.id]);
    entered.open();await release.promise;
  });
  await entered.promise;
  const cancel=inTx(rt2,()=>rt2.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'CANCELLED')`,[c.id])).then(()=>({ok:true}),error=>({ok:false,code:error.code}));
  await until(async()=>(await lockWaiters())>=1,'the cancel to wait for the outcome transaction');
  release.open();await writer;
  const lost=await cancel;
  assert.equal(lost.ok,false);assert.ok([UNIQUE_VIOLATION,SERIALIZATION_FAILURE].includes(lost.code),lost.code);
  assert.deepEqual(await statusOf(db,c.id),{seq:3,status:'COMPLETE'});
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${OUTCOMES} WHERE comparison_id=$1`,[c.id])).rows[0].n,1);
  // 2. the cancel holds the key first: the outcome transaction waits at its COMPLETE event and fails; its outcome row is rolled back with it
  c=await evaluating(owner);await withBenchmark(c);
  entered=gate();release=gate();
  const canceller=inTx(rt,async()=>{await rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'CANCELLED')`,[c.id]);entered.open();await release.promise;});
  await entered.promise;
  const racer=inTx(rt2,async()=>{
    const row=outcomeRow(c);
    await rt2.query(`INSERT INTO ${OUTCOMES}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,index)=>'$'+(index+1)).join(',')})`,Object.values(row));
    await rt2.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'COMPLETE')`,[c.id]);
  }).then(()=>({ok:true}),error=>({ok:false,code:error.code}));
  await until(async()=>(await lockWaiters())>=1,'the outcome transaction to wait for the cancel');
  release.open();await canceller;
  const missed=await racer;
  assert.equal(missed.ok,false);assert.ok([UNIQUE_VIOLATION,SERIALIZATION_FAILURE].includes(missed.code),missed.code);
  assert.deepEqual(await statusOf(db,c.id),{seq:3,status:'CANCELLED'});
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${OUTCOMES} WHERE comparison_id=$1`,[c.id])).rows[0].n,0,'no orphan outcome');
  // 3. through the writer: the lost key is retried, the retry meets the cancelled status and answers a refusal
  c=await evaluating(owner);await withBenchmark(c);await evaluateAll(c);
  entered=gate();release=gate();
  const holder=inTx(rt,async()=>{await rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'CANCELLED')`,[c.id]);entered.open();await release.promise;});
  await entered.promise;
  const decided=decide(c,[['DEVELOPMENT_EVIDENCE'],['DEVELOPMENT_EVIDENCE']]);
  const viaWriter=writeOutcome(rt2,outcomeInput(c,decided));
  await until(async()=>(await lockWaiters())>=1,'the outcome writer to wait for the cancel');
  release.open();await holder;
  const answer=await viaWriter;
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,STORE_CODES.NOT_CANCELLABLE,'quant_comparison_outcome_status'],'a writer that lost to a cancel is a status refusal, not an integrity failure');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${OUTCOMES} WHERE comparison_id=$1`,[c.id])).rows[0].n,0);
});

test('outcome (F3): every participant reported as evaluated needs its stored evaluation row and the stored time; not-evaluated and excluded ones need none',async()=>{
  const owner=await newOwner('s2cr-outcome-evals');
  const c=await evaluating(owner,{count:3});await withBenchmark(c);
  const [a,b,d]=c.ids;
  const outcomeSql=row=>[`INSERT INTO ${OUTCOMES}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,index)=>'$'+(index+1)).join(',')})`,Object.values(row)];
  const attempt=participants=>inTx(rt,()=>rt.query(...outcomeSql(outcomeRow(c,{participants}))));
  const order=label=>[QR004,'quant_comparison_outcome_order',label];
  const at=c.frozen+1;
  const status=(id,state,time)=>({id,status:state,created_at_ms:time});
  // no evaluation record at all
  await refusedBy(attempt([status(a,'DEVELOPMENT_EVIDENCE',at),status(b,'DEVELOPMENT_EVIDENCE',at),status(d,'DEVELOPMENT_EVIDENCE',at)]),QR004,'quant_comparison_outcome_order');
  const bare=await writeOutcome(rt,outcomeInput(c,decide(c,[['DEVELOPMENT_EVIDENCE'],['DEVELOPMENT_EVIDENCE'],['DEVELOPMENT_EVIDENCE']])));
  assert.deepEqual([bare.ok,bare.code,bare.detail],[false,CODES.QR3_INTEGRITY_FAILED,'quant_comparison_outcome_order']);
  // one of three evaluated: the other two still need theirs
  const first=await writeEvaluation(rt,evalInput(c,a));assert.equal(first.ok,true);
  await tick();
  await refusedBy(attempt([status(a,'DEVELOPMENT_EVIDENCE',first.created_at_ms),status(b,'DEVELOPMENT_EVIDENCE',at),status(d,'NOT_EVALUATED',null)]),...order('b has no record'));
  // a NOT_EVALUATED participant must have no stored record: a has one
  await refusedBy(attempt([status(a,'NOT_EVALUATED',null),status(b,'NOT_EVALUATED',null),status(d,'NOT_EVALUATED',null)]),...order('NOT_EVALUATED with a stored record'));
  // UNAVAILABLE needs no record, but a stored one must match its time
  await refusedBy(attempt([status(a,'UNAVAILABLE',first.created_at_ms+1),status(b,'NOT_EVALUATED',null),status(d,'NOT_EVALUATED',null)]),...order('UNAVAILABLE with a stored record and another time'));
  await refusedBy(attempt([status(a,'UNAVAILABLE',null),status(b,'NOT_EVALUATED',null),status(d,'NOT_EVALUATED',null)]),...order('UNAVAILABLE with a stored record and no time'));
  const second=await writeEvaluation(rt,evalInput(c,b));assert.equal(second.ok,true);
  await tick();
  // the stored time must be reported exactly
  for(const [label,time] of [['one millisecond later',first.created_at_ms+1],['one millisecond earlier',first.created_at_ms-1],['the freeze time',c.frozen],['no time',undefined],['null',null],['a text time',String(first.created_at_ms)],['a fractional time',first.created_at_ms+0.5]]){
    const body=time===undefined?{id:a,status:'DEVELOPMENT_EVIDENCE'}:status(a,'DEVELOPMENT_EVIDENCE',time);
    await refusedBy(attempt([body,status(b,'DEVELOPMENT_EVIDENCE',second.created_at_ms),status(d,'NOT_EVALUATED',null)]),...order(label));
  }
  await refusedBy(attempt([status(a,'DEVELOPMENT_EVIDENCE',first.created_at_ms),status(b,'DEVELOPMENT_EVIDENCE',second.created_at_ms),{id:d,created_at_ms:at}]),...order('a participant without a status counts as evaluated and d has no record'));
  const wrongTimes=decide(c,[['DEVELOPMENT_EVIDENCE'],['DEVELOPMENT_EVIDENCE'],['NOT_EVALUATED']]);
  const viaWriter=await writeOutcome(rt,outcomeInput(c,wrongTimes));
  assert.deepEqual([viaWriter.ok,viaWriter.code,viaWriter.detail],[false,CODES.QR3_INTEGRITY_FAILED,'quant_comparison_outcome_order'],'the writer reports the times the pure decision was given');
  assert.deepEqual(await statusOf(db,c.id),{seq:2,status:'EVALUATING'});
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${OUTCOMES} WHERE comparison_id=$1`,[c.id])).rows[0].n,0);
  // exact stored times are accepted; each not-evaluated or excluded status needs no record
  for(const excluded of ['NOT_EVALUATED','UNAVAILABLE','EXCLUDED_COVERAGE','EXCLUDED_INTEGRITY','EXCLUDED_INCOMPATIBLE']){
    const run=await evaluating(owner,{count:3});await withBenchmark(run);
    const [x,y,z]=run.ids;
    const writtenX=await writeEvaluation(rt,evalInput(run,x)),writtenY=await writeEvaluation(rt,evalInput(run,y));
    assert.deepEqual([writtenX.ok,writtenY.ok],[true,true]);
    await tick();
    const row=outcomeRow(run,{participants:[status(x,'DEVELOPMENT_EVIDENCE',writtenX.created_at_ms),status(y,'INADEQUATE_SAMPLE',writtenY.created_at_ms),status(z,excluded,null)]});
    await inTx(rt,async()=>{await rt.query(...outcomeSql(row));await rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'COMPLETE')`,[run.id]);});
    assert.deepEqual(await statusOf(db,run.id),{seq:3,status:'COMPLETE'},excluded);
  }
  // UNAVAILABLE with a stored record and its exact time is accepted too
  {
    const run=await evaluating(owner,{count:3});await withBenchmark(run);
    const [x,y,z]=run.ids;
    const written=[];for(const id of [x,y,z]){const result=await writeEvaluation(rt,evalInput(run,id));assert.equal(result.ok,true);written.push(result.created_at_ms);}
    await tick();
    const row=outcomeRow(run,{participants:[status(x,'DEVELOPMENT_EVIDENCE',written[0]),status(y,'INADEQUATE_SAMPLE',written[1]),status(z,'UNAVAILABLE',written[2])]});
    await inTx(rt,async()=>{await rt.query(...outcomeSql(row));await rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'COMPLETE')`,[run.id]);});
    assert.deepEqual(await statusOf(db,run.id),{seq:3,status:'COMPLETE'},'UNAVAILABLE with a record');
  }
  // through the writer, with the stored times
  c.times={[a]:first.created_at_ms,[b]:second.created_at_ms};
  const third=await writeEvaluation(rt,evalInput(c,d));assert.equal(third.ok,true);c.times[d]=third.created_at_ms;
  await tick();
  const good=await writeOutcome(rt,outcomeInput(c,decide(c,[['DEVELOPMENT_EVIDENCE'],['DEVELOPMENT_EVIDENCE'],['DEVELOPMENT_EVIDENCE']])));
  assert.equal(good.ok,true,JSON.stringify(good));
  const view=await readComparisonResults(rt,{owner_id:owner,comparison_id:c.id});
  assert.equal(view.ok,true,JSON.stringify(view));
});

test('outcome: the race between an evaluation record and the outcome ends in exactly one 40001 (SERIALIZABLE)',async()=>{
  const owner=await newOwner('s2cr-outcome-eval-race');
  const c=await evaluating(owner);await withBenchmark(c);
  const evaluationDone=gate(),outcomeDone=gate();
  const evaluationRow=evalRow(c,c.ids[0]),outcomeValues=outcomeRow(c);
  const insertSql=(table,row)=>[`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,index)=>'$'+(index+1)).join(',')})`,Object.values(row)];
  const settle=promise=>promise.then(()=>({ok:true}),error=>({ok:false,code:error.code}));
  // both transactions take their snapshot before either commits: the evaluation reads the status, the outcome reads the evaluation rows
  const evaluationTx=settle(inTx(rt,async()=>{
    await rt.query(...insertSql(EVALUATIONS,evaluationRow));
    evaluationDone.open();
    await outcomeDone.promise;
  }));
  const outcomeTx=settle(inTx(rt2,async()=>{
    await evaluationDone.promise;
    try{
      await rt2.query(...insertSql(OUTCOMES,outcomeValues));
      await rt2.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'COMPLETE')`,[c.id]);
    }finally{outcomeDone.open();}
    await evaluationTx;
  }));
  const results=await Promise.all([evaluationTx,outcomeTx]);
  assert.deepEqual(results.map(item=>item.ok).sort(),[false,true],JSON.stringify(results));
  assert.equal(results.find(item=>!item.ok).code,SERIALIZATION_FAILURE,'the loser is a serialization failure');
  const count=async table=>(await db.query(`SELECT count(*)::int n FROM ${table} WHERE comparison_id=$1`,[c.id])).rows[0].n;
  assert.equal(await count(EVALUATIONS)+await count(OUTCOMES),1,'exactly one of the two writes is stored');
  assert.deepEqual(await statusOf(db,c.id),await count(OUTCOMES)===1?{seq:3,status:'COMPLETE'}:{seq:2,status:'EVALUATING'});
});

/* ---- 4. replay events ---- */

test('replay events: match, mismatch and disabled append; the outcome and the status never change; every event is later than the outcome',async()=>{
  const owner=await newOwner('s2cr-replay');
  const {c,written}=await completed(owner,{evaluate:true});
  const outcomeBefore=await rowDigest(db,OUTCOMES),eventsBefore=(await db.query(`SELECT * FROM ${EVENTS} WHERE comparison_id=$1 ORDER BY seq`,[c.id])).rows;
  const prior=written.outcome_hash;
  const events=[];
  events.push(await writeReplayEvent(rt,{owner_id:owner,comparison_id:c.id,kind:'REPLAY_MATCH',prior_outcome_hash:prior,replay_outcome_hash:prior,replay_run_id:'replay-run-1'}));
  await tick();
  events.push(await writeReplayEvent(rt,{owner_id:owner,comparison_id:c.id,kind:'REPLAY_MISMATCH',prior_outcome_hash:prior,replay_outcome_hash:hex('different'),first_differing_code:'PARTICIPANT_METRIC_DIFFERS',replay_run_id:'replay-run-2'}));
  await tick();
  events.push(await writeReplayEvent(rt,{owner_id:owner,comparison_id:c.id,kind:'REPRODUCTION_DISABLED',prior_outcome_hash:prior}));
  assert.ok(events.every(item=>item.ok&&item.attempts===1),JSON.stringify(events));
  assert.equal(new Set(events.map(item=>item.replay_event_id)).size,3);
  assert.ok(events.every(item=>item.at_ms>written.created_at_ms),'later than the outcome');
  assert.deepEqual(await rowDigest(db,OUTCOMES),outcomeBefore,'the outcome row is byte-identical (I4)');
  assert.deepEqual((await db.query(`SELECT * FROM ${EVENTS} WHERE comparison_id=$1 ORDER BY seq`,[c.id])).rows,eventsBefore,'replay events change no status');
  const view=await readComparisonResults(rt,{owner_id:owner,comparison_id:c.id});
  assert.equal(view.ok,true,JSON.stringify(view));
  assert.deepEqual(view.replay_events.map(item=>[item.kind,item.replay_run_id,item.prior_outcome_hash,item.replay_outcome_hash,item.first_differing_code]),[
    ['REPLAY_MATCH','replay-run-1',prior,prior,null],['REPLAY_MISMATCH','replay-run-2',prior,hex('different'),'PARTICIPANT_METRIC_DIFFERS'],['REPRODUCTION_DISABLED',null,prior,null,null]]);
  assert.deepEqual(view.replay_events.map(item=>item.replay_event_id),events.map(item=>item.replay_event_id));
  assert.equal(view.outcome.outcome_hash,prior);
  // a caller-chosen event id is kept; the same id twice is ALREADY_RECORDED
  const chosen=randomUUID();
  await tick();
  assert.equal((await writeReplayEvent(rt,{owner_id:owner,comparison_id:c.id,kind:'REPRODUCTION_DISABLED',prior_outcome_hash:prior,replay_event_id:chosen})).replay_event_id,chosen);
  assert.deepEqual(await writeReplayEvent(rt,{owner_id:owner,comparison_id:c.id,kind:'REPRODUCTION_DISABLED',prior_outcome_hash:prior,replay_event_id:chosen}),{ok:false,code:CODES.INVALID_FIELDS,detail:'ALREADY_RECORDED'});
});

test('replay events: guard and CHECK refusals by name, the time rule with an injected clock, and the writer input checks',async()=>{
  const owner=await newOwner('s2cr-replay-guard');
  const {c,written}=await completed(owner);
  const prior=written.outcome_hash;
  const row=(over={})=>({comparison_id:c.id,kind:'REPLAY_MATCH',prior_outcome_hash:prior,replay_outcome_hash:prior,...over});
  const guard=name=>[QR004,'quant_comparison_'+name];
  const check=name=>[CHECK_VIOLATION,'quant_comparison_replay_events_'+name];
  const evaluatingOnly=await evaluating(owner);
  const cases=[
    ['no outcome yet',{...row(),comparison_id:evaluatingOnly.id},...guard('replay_order')],
    ['a prior hash that is not the stored outcome',row({prior_outcome_hash:hex('other'),replay_outcome_hash:hex('other')}),...guard('replay_order')],
    ['unknown comparison',row({comparison_id:'no-such-comparison'}),...guard('replay_spec')],
    ['kind unknown',row({kind:'REPLAY_BOGUS'}),...check('kind_check')],
    ['match with a different replay hash',row({replay_outcome_hash:hex('other')}),...check('shape_check')],
    ['match without a replay hash',row({replay_outcome_hash:null}),...check('shape_check')],
    ['match with a differing code',row({first_differing_code:'SOME_CODE'}),...check('shape_check')],
    ['mismatch with the same hash',row({kind:'REPLAY_MISMATCH',first_differing_code:'SOME_CODE'}),...check('shape_check')],
    ['mismatch without a replay hash',row({kind:'REPLAY_MISMATCH',replay_outcome_hash:null,first_differing_code:'SOME_CODE'}),...check('shape_check')],
    ['mismatch without a differing code',row({kind:'REPLAY_MISMATCH',replay_outcome_hash:hex('other')}),...check('shape_check')],
    ['disabled with a replay hash',row({kind:'REPRODUCTION_DISABLED'}),...check('shape_check')],
    ['disabled with a differing code',row({kind:'REPRODUCTION_DISABLED',replay_outcome_hash:null,first_differing_code:'SOME_CODE'}),...check('shape_check')],
    ['replay hash not hex',row({replay_outcome_hash:'abc'}),...check('replay_hash_check')],
    ['differing code in lower case',row({kind:'REPLAY_MISMATCH',replay_outcome_hash:hex('other'),first_differing_code:'lower'}),...check('code_check')],
    ['replay run id invalid',row({replay_run_id:'-bad id'}),...check('run_id_check')]];
  const before=await allRows(db);
  for(const [label,values,code,constraint] of cases)await refusedBy(insert(rt,REPLAYS,values),code,constraint).catch(error=>{throw Error(label+': '+error.message);});
  assert.deepEqual(await allRows(db),before,'nothing was stored');
  // the time rule: a replay event is strictly later than the outcome (injected clock)
  const outcomeAt=Number((await db.query(`SELECT created_at_ms FROM ${OUTCOMES} WHERE comparison_id=$1`,[c.id])).rows[0].created_at_ms);
  const values=row(),columns=Object.keys(values);
  const attempt=ms=>withClock('quant_comparison_guard_replay_event',ms,()=>db.query(`INSERT INTO ${REPLAYS}(${columns.join(',')}) VALUES(${columns.map((_,index)=>'$'+(index+1)).join(',')}) RETURNING at_ms`,Object.values(values)));
  await refusedBy(attempt(outcomeAt),QR004,'quant_comparison_replay_order');
  await refusedBy(attempt(outcomeAt-1),QR004,'quant_comparison_replay_order');
  assert.equal(Number((await attempt(outcomeAt+1)).rows[0].at_ms),outcomeAt+1);
  // writer input checks and ownership
  const untouchable={isTransaction:false,query(){throw Error('query on a refused request');},transaction(){throw Error('transaction on a refused request');}};
  const base={owner_id:owner,comparison_id:c.id,kind:'REPLAY_MATCH',prior_outcome_hash:prior,replay_outcome_hash:prior};
  const pure=[[{...base,kind:'OTHER'},'KIND'],[{...base,prior_outcome_hash:'xyz'},'PRIOR_OUTCOME_HASH'],[{...base,replay_outcome_hash:'xyz'},'REPLAY_OUTCOME_HASH'],
    [{...base,replay_outcome_hash:hex('other')},'REPLAY_SHAPE'],[{...base,first_differing_code:'SOME_CODE'},'REPLAY_SHAPE'],
    [{...base,kind:'REPLAY_MISMATCH',replay_outcome_hash:prior,first_differing_code:'SOME_CODE'},'REPLAY_SHAPE'],[{...base,kind:'REPLAY_MISMATCH',replay_outcome_hash:hex('other')},'REPLAY_SHAPE'],
    [{...base,kind:'REPRODUCTION_DISABLED'},'REPLAY_SHAPE'],[{...base,replay_run_id:'-bad'},'REPLAY_RUN_ID'],[{...base,replay_event_id:'not-a-uuid'},'REPLAY_EVENT_ID'],
    [{...base,kind:'REPLAY_MISMATCH',replay_outcome_hash:hex('other'),first_differing_code:'lower'},'FIRST_DIFFERING_CODE']];
  for(const [input,detail] of pure){const answer=await writeReplayEvent(untouchable,input);assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.INVALID_FIELDS,detail],detail);}
  for(const input of [{...base,owner_id:await newOwner('s2cr-replay-other')},{...base,comparison_id:'no-such-comparison'},{...base,comparison_id:'bad id'}])
    assert.deepEqual(await writeReplayEvent(rt,input),{ok:false,code:'NOT_FOUND',detail:null});
  const stale=await writeReplayEvent(rt,{...base,prior_outcome_hash:hex('other'),replay_outcome_hash:hex('other')});
  assert.deepEqual([stale.ok,stale.code,stale.detail],[false,CODES.QR3_INTEGRITY_FAILED,'quant_comparison_replay_order']);
  const noOutcome=await writeReplayEvent(rt,{...base,comparison_id:evaluatingOnly.id});
  assert.equal(noOutcome.detail,'quant_comparison_replay_order');
  assert.deepEqual(await allRows(db),before,'nothing was stored by a refused write');
});

test('replay events: a replay event needs a later transaction than its outcome (the same-transaction helper)',async()=>{
  const owner=await newOwner('s2cr-replay-tx');
  const c=await evaluating(owner);await withBenchmark(c);
  const row=outcomeRow(c);
  const insertSql=(table,values)=>[`INSERT INTO ${table}(${Object.keys(values).join(',')}) VALUES(${Object.keys(values).map((_,index)=>'$'+(index+1)).join(',')})`,Object.values(values)];
  const before=await allRows(db);
  // outcome, COMPLETE and a replay event in one transaction: the replay guard sees the outcome of its own transaction and refuses
  await refusedBy(inTx(rt,async()=>{
    await rt.query(...insertSql(OUTCOMES,row));
    await rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'COMPLETE')`,[c.id]);
    await tick();
    await rt.query(...insertSql(REPLAYS,{comparison_id:c.id,kind:'REPRODUCTION_DISABLED',prior_outcome_hash:row.outcome_hash}));
  }),QR004,'quant_comparison_replay_order');
  assert.deepEqual(await allRows(db),before,'the whole transaction was rolled back');
  // the same event after the outcome committed is accepted
  await inTx(rt,async()=>{await rt.query(...insertSql(OUTCOMES,row));await rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'COMPLETE')`,[c.id]);});
  await tick();
  const written=await writeReplayEvent(rt,{owner_id:owner,comparison_id:c.id,kind:'REPRODUCTION_DISABLED',prior_outcome_hash:row.outcome_hash});
  assert.equal(written.ok,true,JSON.stringify(written));
});

/* ---- 5. insert-only layers, isolation, shadowing ---- */

test('insert-only: UPDATE, DELETE and TRUNCATE are refused at both layers on every result table with rows present; the replication role skips no guard',async()=>{
  const owner=await newOwner('s2cr-insert-only');
  const {c,written}=await completed(owner,{evaluate:true});
  await tick();
  await writeReplayEvent(rt,{owner_id:owner,comparison_id:c.id,kind:'REPRODUCTION_DISABLED',prior_outcome_hash:written.outcome_hash});
  const before=await allRows(db);
  for(const table of RESULT_TABLES)assert.ok((await rowDigest(db,table)).n>=1,table+' holds a row');
  for(const table of RESULT_TABLES){
    await refused(rt.query(`DELETE FROM ${table}`),DENIED);await refused(rt.query(`TRUNCATE ${table}`),DENIED);await refused(rt.query(`UPDATE ${table} SET comparison_id=comparison_id`),DENIED);
  }
  const touch={[EVALUATIONS]:'body_hash=body_hash',[BENCHMARKS]:'body_hash=body_hash',[OUTCOMES]:'outcome_hash=outcome_hash',[REPLAYS]:'at_ms=at_ms'};
  const moved={[EVALUATIONS]:'created_at_ms=created_at_ms+1',[BENCHMARKS]:'created_at_ms=0',[OUTCOMES]:"outcome='QUALIFIED_TIE'",[REPLAYS]:"kind='REPLAY_MATCH'"};
  for(const table of RESULT_TABLES){
    await refused(db.query(`UPDATE ${table} SET ${touch[table]}`),QR002);await refused(db.query(`UPDATE ${table} SET ${moved[table]}`),QR002);
    await refused(db.query(`DELETE FROM ${table}`),QR002);await refused(db.query(`TRUNCATE ${table}`),QR002);
    await refused(dl.query(`DELETE FROM ${table}`),QR002);await refused(tr.query(`TRUNCATE ${table}`),QR002);
    await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(`DELETE FROM ${table}`);}),QR002);
    await refused(db.transaction(async()=>{await db.query("SET LOCAL session_replication_role = 'replica'");await db.query(`UPDATE ${table} SET ${touch[table]}`);}),QR002);
  }
  // an upsert that would rewrite a stored result needs UPDATE privilege for the runtime role
  const row=evalRow(c,c.ids[0]);
  await refused(inTx(rt,()=>rt.query(`INSERT INTO ${EVALUATIONS}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,index)=>'$'+(index+1)).join(',')}) ON CONFLICT (comparison_id,participant_id) DO UPDATE SET body_hash=EXCLUDED.body_hash`,Object.values(row))),DENIED);
  assert.deepEqual(await allRows(db),before,'no refusal changed a row');
});

test('shadowing: TEMP tables and functions named like the objects the result guards use fool none of them',async()=>{
  const owner=await newOwner('s2cr-shadow');
  const c=await evaluating(owner);
  const row=evalRow(c,c.ids[0]);
  const columns=Object.keys(row);
  // empty TEMP shadows of the tables the guards read, first on the search path: a guard that read them would find no spec and refuse the row
  const stamped=await rt.transaction(async()=>{
    for(const name of ['quant_comparison_specs','quant_comparison_status_events','quant_comparison_participants','quant_comparison_benchmarks','quant_comparison_outcomes'])
      await rt.query(`CREATE TEMP TABLE ${name}(x integer) ON COMMIT DROP`);
    await rt.query("CREATE FUNCTION pg_temp.clock_timestamp() RETURNS timestamptz LANGUAGE sql AS $$ SELECT 'epoch'::timestamptz $$");
    await rt.query("CREATE FUNCTION pg_temp.jsonb_typeof(jsonb) RETURNS text LANGUAGE sql AS $$ SELECT 'object'::text $$");
    await rt.query('SET LOCAL search_path = pg_temp, public');
    const inserted=(await rt.query(`INSERT INTO public.quant_comparison_evaluations(${columns.join(',')}) VALUES(${columns.map((_,index)=>'$'+(index+1)).join(',')}) RETURNING created_at_ms`,Object.values(row))).rows[0];
    assert.equal((await rt.query('SELECT count(*)::int n FROM pg_temp.quant_comparison_specs')).rows[0].n,0);
    return Number(inserted.created_at_ms);
  },serializable);
  assert.ok(stamped>c.frozen&&stamped>1e12,'the row carries the database time, not the shadow function: '+stamped);
  // a shadowed guard function cannot make an insert below SERIALIZABLE pass either
  await refused(rt.transaction(async()=>{
    await rt.query("CREATE FUNCTION pg_temp.current_setting(text) RETURNS text LANGUAGE sql AS $$ SELECT 'serializable'::text $$");
    await rt.query('SET LOCAL search_path = pg_temp, pg_catalog, public');
    await rt.query(`INSERT INTO ${BENCHMARKS}(comparison_id,benchmark_id,spec_hash,body_canonical,body_hash,created_at_ms) VALUES('x','y','h','{}','h',0)`);
  },{isolation:'READ COMMITTED'}),QR003);
  assert.equal((await classifyQuantComparison(db)).state,'INSTALLED');
});

/* ---- 6. owner-scoped reads ---- */

test('read: owner-scoped READ ONLY; absent, foreign and malformed ids answer alike; stored bodies are re-hashed; a damaged row is QR3_INTEGRITY_FAILED',async()=>{
  const owner=await newOwner('s2cr-read'),other=await newOwner('s2cr-read-other');
  const {c,written}=await completed(owner,{evaluate:true});
  await tick();
  await writeReplayEvent(rt,{owner_id:owner,comparison_id:c.id,kind:'REPRODUCTION_DISABLED',prior_outcome_hash:written.outcome_hash});
  const watched=spy(rt);
  const view=await readComparisonResults(watched.db,{owner_id:owner,comparison_id:c.id});
  assert.equal(view.ok,true,JSON.stringify(view));
  assert.equal(watched.log[0],'SET TRANSACTION READ ONLY','the first statement fixes the mode');
  assert.ok(watched.log.slice(1).every(sql=>/^(SELECT|\s*SELECT)/.test(sql)),'a read only selects: '+watched.log.join(' | ').slice(0,300));
  assert.deepEqual([view.evaluations.length,view.benchmark!==null,view.outcome.outcome,view.replay_events.length],[2,true,'NO_QUALIFIED_RESULT',1]);
  // F3 on the stored rows: every result time is later than the freeze, the replay later than the outcome
  assert.ok(view.evaluations.every(item=>item.created_at_ms>view.frozen_at_ms)&&view.benchmark.created_at_ms>view.frozen_at_ms&&view.outcome.created_at_ms>view.frozen_at_ms);
  assert.ok(view.replay_events.every(item=>item.at_ms>view.outcome.created_at_ms));
  await assert.rejects(rt.transaction(async()=>{await rt.query('SET TRANSACTION READ ONLY');await rt.query(`INSERT INTO ${REPLAYS}(comparison_id,kind,prior_outcome_hash) VALUES($1,'REPRODUCTION_DISABLED',$2)`,[c.id,written.outcome_hash]);},{isolation:'REPEATABLE READ'}),error=>error.code==='25006');
  const absent=await readComparisonResults(rt,{owner_id:owner,comparison_id:'no-such-comparison'});
  const foreign=await readComparisonResults(rt,{owner_id:other,comparison_id:c.id});
  const malformed=await readComparisonResults(rt,{owner_id:owner,comparison_id:'bad id; DROP TABLE'});
  const noOwner=await readComparisonResults(rt,{comparison_id:c.id});
  for(const answer of [absent,foreign,malformed,noOwner])assert.deepEqual(answer,{ok:false,code:'NOT_FOUND',detail:null});
  const inside=await rt.transaction(async()=>{await rt.query('SET TRANSACTION READ ONLY');return readComparisonResults(rt,{owner_id:owner,comparison_id:c.id});},{isolation:'REPEATABLE READ'});
  assert.deepEqual(inside,view);
  await assert.rejects(rt.transaction(()=>readComparisonResults(rt,{owner_id:owner,comparison_id:c.id}),serializable),/needs a READ ONLY transaction/);
  // a comparison with no result row reads empty, not NOT_FOUND
  const bare=await make(owner);
  assert.deepEqual(await readComparisonResults(rt,{owner_id:owner,comparison_id:bare.id}),{ok:true,code:null,detail:null,comparison_id:bare.id,spec_hash:bare.specHash,frozen_at_ms:bare.frozen,evaluations:[],benchmark:null,outcome:null,replay_events:[]});
  // damaged stored rows (planted by the table owner inside a rolled-back transaction with the guard lifted): never a partial view
  const unspaced=text=>JSON.stringify(JSON.parse(text),null,1);   // valid JSON with the right digest, but not the canonical text
  const plant=async(lift,statements)=>db.transaction(async()=>{
    for(const statement of lift)await db.query(statement);
    for(const [sql,params=[]] of statements)await db.query(sql,params);
    await db.query('SET TRANSACTION READ ONLY');
    const answer=await readComparisonResults(db,{owner_id:owner,comparison_id:target.id});
    throw Object.assign(new Error('planted'),{answer});
  },serializable).catch(error=>{if(error.message==='planted')return error.answer;throw error;});
  let target=await evaluating(owner);
  const lifted=table=>[`ALTER TABLE public.${table} DISABLE TRIGGER ${table}_guard`];
  const spaced=unspaced(canonical(evalBody(target)));
  let answer=await plant(lifted('quant_comparison_evaluations'),[[`INSERT INTO ${EVALUATIONS}(comparison_id,participant_id,spec_hash,body_canonical,body_hash,created_at_ms) VALUES($1,$2,$3,$4,$5,$6)`,
    [target.id,target.ids[0],target.specHash,spaced,hash(spaced),target.frozen+1]]]);
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'EVALUATION_BODY']);
  const spacedBench=unspaced(canonical(benchBody()));
  answer=await plant(lifted('quant_comparison_benchmarks'),[[`INSERT INTO ${BENCHMARKS}(comparison_id,benchmark_id,spec_hash,body_canonical,body_hash,created_at_ms) VALUES($1,$2,$3,$4,$5,$6)`,
    [target.id,BENCHMARK_ID,target.specHash,spacedBench,hash(spacedBench),target.frozen+1]]]);
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'BENCHMARK_BODY']);
  target=await evaluating(owner);await withBenchmark(target);
  const spacedOutcome=unspaced(canonical(outcomeRecord(target)));
  answer=await plant(lifted('quant_comparison_outcomes'),[[`INSERT INTO ${OUTCOMES}(comparison_id,outcome,spec_hash,context_key,body_canonical,outcome_hash,created_at_ms) VALUES($1,'NO_QUALIFIED_RESULT',$2,$3,$4,$5,$6)`,
    [target.id,target.specHash,target.contextKey,spacedOutcome,hash(spacedOutcome),target.frozen+1]],[`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'COMPLETE')`,[target.id]]]);
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'OUTCOME_BODY']);
  // cross-checks against the spec: rows that are valid on their own but belong to another spec, window or participant set
  const evalPlant=(run,id,body,columns={})=>[`INSERT INTO ${EVALUATIONS}(comparison_id,participant_id,spec_hash,body_canonical,body_hash,created_at_ms) VALUES($1,$2,$3,$4,$5,$6)`,
    [run.id,id,columns.spec_hash??run.specHash,canonical(body),hash(canonical(body)),run.frozen+1]];
  target=await evaluating(owner);
  answer=await plant(lifted('quant_comparison_evaluations'),[evalPlant(target,target.ids[0],evalBody(target,{window:{start_ms:target.window.start_ms,end_ms:target.window.end_ms-MINUTE}}))]);
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'EVALUATION_WINDOW']);
  answer=await plant(lifted('quant_comparison_evaluations'),[evalPlant(target,target.ids[0],evalBody(target,{window:{start_ms:target.window.start_ms+MINUTE,end_ms:target.window.end_ms}}))]);
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'EVALUATION_WINDOW']);
  answer=await plant(lifted('quant_comparison_evaluations'),[evalPlant(target,target.ids[0],evalBody(target,{record_spec_hash:hex('other')}),{spec_hash:hex('other')})]);
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'EVALUATION_SPEC'],'the record and the column agree with each other but not with the spec');
  answer=await plant(lifted('quant_comparison_evaluations'),[evalPlant(target,target.ids[0],evalBody(target))]);
  assert.equal(answer.ok,true,'control: a matching planted row reads');
  answer=await plant(lifted('quant_comparison_benchmarks'),[[`INSERT INTO ${BENCHMARKS}(comparison_id,benchmark_id,spec_hash,body_canonical,body_hash,created_at_ms) VALUES($1,$2,$3,$4,$5,$6)`,
    [target.id,BENCHMARK_ID,hex('other'),canonical(benchBody()),hash(canonical(benchBody())),target.frozen+1]]]);
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'BENCHMARK_SPEC']);
  const outcomePlant=(run,record,columns={})=>{
    const text=canonical(record);
    return [[`INSERT INTO ${OUTCOMES}(comparison_id,outcome,spec_hash,context_key,body_canonical,outcome_hash,created_at_ms) VALUES($1,'NO_QUALIFIED_RESULT',$2,$3,$4,$5,$6)`,
      [run.id,columns.spec_hash??run.specHash,columns.context_key??run.contextKey,text,hash(text),run.frozen+1]],[`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,3,'COMPLETE')`,[run.id]]];
  };
  target=await evaluating(owner);await withBenchmark(target);
  answer=await plant(lifted('quant_comparison_outcomes'),outcomePlant(target,outcomeRecord(target,{spec_hash:hex('other')}),{spec_hash:hex('other')}));
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'OUTCOME_SPEC']);
  answer=await plant(lifted('quant_comparison_outcomes'),outcomePlant(target,outcomeRecord(target,{context_key:hex('other')}),{context_key:hex('other')}));
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'OUTCOME_SPEC']);
  answer=await plant(lifted('quant_comparison_outcomes'),outcomePlant(target,outcomeRecord(target,{participants:[{id:target.ids[0],status:'NOT_EVALUATED'}]})));
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'OUTCOME_PARTICIPANTS']);
  answer=await plant(lifted('quant_comparison_outcomes'),outcomePlant(target,outcomeRecord(target,{participants:target.ids.map(id=>({id,status:'DEVELOPMENT_EVIDENCE',created_at_ms:target.frozen+1}))})));
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'OUTCOME_EVALUATIONS'],'an evaluated participant without a stored record');
  // a stored evaluation row must agree with the outcome: NOT_EVALUATED with a row, and a present row with another time (UNAVAILABLE or evaluated)
  const bothLifted=[...lifted('quant_comparison_evaluations'),...lifted('quant_comparison_outcomes')];
  const withRow=(run,participants)=>[evalPlant(run,run.ids[0],evalBody(run)),...outcomePlant(run,outcomeRecord(run,{participants}))];
  const reported=(run,state,time)=>run.ids.map((id,index)=>index===0?(time===undefined?{id,status:state}:{id,status:state,created_at_ms:time}):{id,status:'NOT_EVALUATED'});
  target=await evaluating(owner);await withBenchmark(target);
  answer=await plant(bothLifted,withRow(target,reported(target,'NOT_EVALUATED')));
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'OUTCOME_EVALUATIONS'],'NOT_EVALUATED with a stored record');
  answer=await plant(bothLifted,withRow(target,reported(target,'UNAVAILABLE',target.frozen+2)));
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'OUTCOME_EVALUATIONS'],'UNAVAILABLE with a stored record and another time');
  answer=await plant(bothLifted,withRow(target,reported(target,'DEVELOPMENT_EVIDENCE',target.frozen+2)));
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'OUTCOME_EVALUATIONS'],'a present record with another time');
  answer=await plant(bothLifted,withRow(target,reported(target,'DEVELOPMENT_EVIDENCE',target.frozen+1)));
  assert.equal(answer.ok,true,'control: a present record with the same time reads');
  answer=await plant(bothLifted,withRow(target,reported(target,'UNAVAILABLE',target.frozen+1)));
  assert.equal(answer.ok,true,'control: UNAVAILABLE with a matching record reads');
  answer=await plant(lifted('quant_comparison_outcomes'),outcomePlant(target,outcomeRecord(target,{participants:reported(target,'UNAVAILABLE')})));
  assert.equal(answer.ok,true,'UNAVAILABLE without a stored record reads');
  answer=await plant(lifted('quant_comparison_outcomes'),outcomePlant(target,outcomeRecord(target)));
  assert.equal(answer.ok,true,'control: a matching planted outcome reads');
  target=c;
  answer=await plant(lifted('quant_comparison_replay_events'),[[`INSERT INTO ${REPLAYS}(comparison_id,kind,prior_outcome_hash,at_ms) VALUES($1,'REPRODUCTION_DISABLED',$2,$3)`,[c.id,written.outcome_hash,view.outcome.created_at_ms]]]);
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'REPLAY_EVENTS'],'a replay event not strictly after the outcome');
  answer=await plant(lifted('quant_comparison_replay_events'),[[`INSERT INTO ${REPLAYS}(comparison_id,kind,prior_outcome_hash,at_ms) VALUES($1,'REPRODUCTION_DISABLED',$2,$3)`,[c.id,hex('not-the-outcome'),Date.now()+1]]]);
  assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,'REPLAY_EVENTS']);
  assert.equal((await readComparisonResults(rt,{owner_id:owner,comparison_id:c.id})).ok,true,'every plant was rolled back');
  assert.equal((await classifyQuantComparison(db)).state,'INSTALLED');
});

/* ---- 7. install facts, inspection, rollback ---- */

test('inspection: the runtime role holds SELECT and INSERT only on the seven record tables; the install lists all eight tables and thirty-three guards',async()=>{
  const report=await inspectQuantComparison(db,{runtimeRole:roleName});
  assert.equal(report.ok,true,report.failures.join());
  assert.equal(report.facts.guards.length,33);assert.ok(report.facts.guards.every(item=>item.enabled==='A'));
  assert.deepEqual(report.facts.runtime_role.tables.map(item=>[item.table,item.insert,item.update,item.delete]).sort((a,b)=>a[0]<b[0]?-1:1),
    ['quant_comparison_benchmarks','quant_comparison_evaluations','quant_comparison_outcomes','quant_comparison_participants','quant_comparison_replay_events','quant_comparison_schema',
      'quant_comparison_specs','quant_comparison_status_events'].map(name=>[name,name!=='quant_comparison_schema',false,false]));
  assert.ok((await inspectQuantComparison(db,{runtimeRole:deleterName})).failures.includes('RUNTIME_ROLE_WRITE_PRIVILEGE:quant_comparison_outcomes:DELETE'));
  assert.ok((await inspectQuantComparison(db,{runtimeRole:truncaterName})).failures.includes('RUNTIME_ROLE_TRUNCATE_PRIVILEGE:quant_comparison_replay_events'));
});

test('rollback: refused while any result table holds a row, with no change; the evidence stays',async()=>{
  const name='robot_s2cr_rb_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(name);
  await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);
  const target=track(new PostgresDatabase({connectionString:urlOf(name),max:3}));
  const user=await new Store(target).createUser({email:'rb-'+randomUUID()+'@example.test',passwordHash:'x'});
  const window=nextWindow(),ids=['rb-a','rb-b'],checked=specFor(ids,window);
  const made=await createComparison(target,{owner_id:user.id,market:{...MARKET},fixture:true,spec:checked.spec,spec_hash:checked.spec_hash,context_key:hex('context'),
    participants:ids.map(id=>({participant_id:id,source_hash:hex('source-'+id),origin:'FIXTURE',fixture:true,context_key:hex('context'),freeze:{subject:{}}}))});
  assert.equal(made.ok,true,JSON.stringify(made));
  await tick();await addEvent(target,made.comparison_id,2,'EVALUATING');await tick();
  const c={id:made.comparison_id,owner:user.id,ids,specHash:checked.spec_hash,window};
  assert.equal((await writeEvaluation(target,evalInput(c,'rb-a'))).ok,true);
  const held=await allRows(target);
  await assert.rejects(rollbackQuantComparison(target),/rollback refused; 6 evidence row\(s\) exist in quant_comparison_specs, quant_comparison_participants, quant_comparison_status_events, quant_comparison_evaluations \(no change made\)/);
  assert.deepEqual(await allRows(target),held,'the evidence rows are still there');
  assert.equal((await classifyQuantComparison(target)).state,'INSTALLED');
});
