import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {migrateMpMemberSet} from '../../src/postgres/mp-member-set-migration.js';
import {freezeOrLoadMemberSet,storeBotState,MP_STORE_MAX_RETRIES} from '../../src/postgres/mp-member-set-store.js';
import {canonical,hash,inspectSource,validateSelection} from '../../src/pine-bridge/source.js';
import {assemble} from '../../src/pine-bridge/template.js';
import {buildMemberSet,memberSetFreshness} from '../../src/multi-pine/member-set.js';
import {MP_CODES} from '../../src/multi-pine/codes.js';

// F11-01 member-set store: freezeOrLoadMemberSet proven on a throwaway PostgreSQL cluster as a real non-owner LOGIN runtime role with the repo grants.
// Every row is a LABELLED FIXTURE (fixture=true, synthetic, never a research result). Rows are insert-only, so each case uses its own owner.
const GRANT_SCRIPT=fileURLToPath(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url));
const sourceDir=new URL('../../src/postgres/',import.meta.url);
const T0=1790000000000;
const QR004='QR004';
let admin,db,rt,rt2,connectionString,templateName,databaseName,roleName,store;
const databases=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const track=pool=>{pools.push(pool);return pool;};
const install=async(target,name)=>target.transaction(async()=>target.query(await fs.readFile(new URL(name,sourceDir),'utf8')));
const grantScript=async role=>(await fs.readFile(GRANT_SCRIPT,'utf8')).replaceAll(":'runtime_role'","'"+role+"'");

const POLICY={paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2};
const CAPITAL=[{broker:'binance-global',configuredEquity:1000,configuredBalance:1000}];
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const MODEL={version:'paper-close-v1',price_tick:0.01,quantity_step:0.00001,fee_bps:0,slippage_bps:0,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};
const SIGNALS={buy:'buy',exit:'sell',timing:'bar_close'};
const basis=capital=>capital.map(a=>({broker:a.broker,configuredEquity:a.configuredEquity,configuredBalance:a.configuredBalance}));
const FIXED_STATE={policy_hash:hash(canonical(POLICY)),capital_basis_hash:hash(canonical(basis(CAPITAL))),funding_cutoff:7};
const botState=async()=>({...FIXED_STATE});
const sourceOf=(n,pine)=>`//@version=6\nindicator("mp store member ${n}")\nbuy = ta.crossover(close, ta.sma(close, ${10+n}))\nsell = ta.crossunder(close, ta.sma(close, ${10+n}))\nplot(close)\n// ${pine}\n`;
const evidenceFor=(snapshot,snapshotHash,tag)=>({snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,
  binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,
  effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},
  decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:structuredClone(MODEL),
  references:{tradingview:tag+'-tv',source_review:tag+'-sr',paper_fixture:tag+'-pf'}});
const JOB_SQL=`INSERT INTO pine_bridge_jobs(job_id,owner_id,bot_id,operation,idempotency_key,request_hash,request,pine_import_id,status,created_at,updated_at,deadline,result)
  VALUES($1,$2,$3,'generate',$4,$5,'{}',$6,$7,$8,$8,$8,$9)`;
const addJob=(target,{owner,bot,pine,dep,status='SUCCEEDED',result})=>
  target.query(JOB_SQL,[randomUUID(),owner,bot,randomUUID(),hash('request-'+randomUUID()),pine,status,T0,JSON.stringify(result===undefined?null:result)]);

/**
 * One owner (and a Bot: another user when split) with COUNT connected members. Each member has a source revision, a DRAFT deployment whose snapshot pins a
 * real integrated Pine artifact, Bridge evidence, and a SUCCEEDED generate job that carries the artifact (the only place the exit version can be derived from).
 * artifact(a,spec) changes the artifact before it is pinned; jobArtifact(a,spec) changes only the artifact the job carries; jobs(spec,world) replaces the default job.
 */
async function newWorld({count=2,split=false,artifact=a=>a,jobArtifact=a=>a,jobs,snapshotBase={}}={}){
  const user=await store.createUser({email:'mp-store-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  const bot=split?await store.createUser({email:'mp-store-bot-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'}):user;
  const ids=Array.from({length:count},()=>randomUUID()).sort();
  const specs=ids.map((id,i)=>{
    const n=i+1,source=sourceOf(n,id);
    return {n,pine:id,version:1,source,sourceHash:hash(source),analysis:{effective_inputs_hash:hash('inputs-'+id),inputs:[{input_id:'i'+n}]},dep:randomUUID()};
  });
  for(const m of specs){
    await db.query('INSERT INTO pine_sources VALUES($1,$2,$8,1,$3,$4,$5,$6,$7)',[m.pine,user.id,m.sourceHash,'Member fixture',m.source,JSON.stringify(m.analysis),T0,bot.id]);
    await db.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[m.pine,m.sourceHash,m.source,JSON.stringify(m.analysis),T0]);
    await db.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)',[m.pine,user.id,bot.id]);
  }
  const projection=specs.map(m=>({pine_import_id:m.pine,source_version:1,source_hash:m.sourceHash,analysis:m.analysis}));
  const selection=validateSelection(inspectSource(specs[0].source),SIGNALS,[]);
  const world={id:user.id,bot:bot.id,specs};
  for(const m of specs){
    const pinned=artifact(assemble(m.source,selection,{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET}).integrated_pine,m);
    m.artifact=pinned;
    const snapshot={policy:POLICY,policy_hash:hash(canonical(POLICY)),capital:CAPITAL,funding_cutoff:7,membership:projection,session:{state:'SETUP',run_id:null},captured_at:1,
      selection,market:{deployment_id:m.dep,pine_import_id:m.pine,source_version:1,...MARKET},source_hash:m.sourceHash,instruction_versions:{template:'fixture'},artifact_hash:hash(pinned),...snapshotBase};
    const snapshotHash=hash(canonical(snapshot)),body=evidenceFor(snapshot,snapshotHash,'fixture-'+m.n);
    await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$7,$3,1,$4,$5,'DRAFT',$6)",
      [m.dep,user.id,m.pine,JSON.stringify(snapshot),snapshotHash,T0,bot.id]);
    await db.query('INSERT INTO pine_bridge_evidence(deployment_id,snapshot_hash,evidence,evidence_hash,recorded_at) VALUES($1,$2,$3,$4,$5)',[m.dep,snapshotHash,JSON.stringify(body),hash(canonical(body)),T0]);
    const own={owner:user.id,bot:bot.id,pine:m.pine,dep:m.dep,result:{integrated_pine:jobArtifact(pinned,m),deployment_id:m.dep,artifact_status:'DRAFT'}};
    if(jobs)await jobs(m,{world,own,add:over=>addJob(db,{...own,...over})});
    else await addJob(db,own);
  }
  return world;
}
const namesOf=world=>world.specs.map(m=>({pine_import_id:m.pine,deployment_id:m.dep}));
const call=(world,over={},target=rt)=>freezeOrLoadMemberSet(target,{owner_id:world.id,bot_id:world.bot,fixture:true,member_deployments:namesOf(world),readBotState:botState,...over});
const counts=async world=>({
  sets:(await db.query('SELECT count(*)::int n FROM mp_member_sets WHERE owner_id=$1',[world.id])).rows[0].n,
  members:(await db.query('SELECT count(*)::int n FROM mp_member_set_members WHERE owner_id=$1',[world.id])).rows[0].n});
const rowDigest=async table=>(await db.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t`)).rows[0];
const allDigests=async()=>({sets:await rowDigest('mp_member_sets'),members:await rowDigest('mp_member_set_members')});
const stored=async id=>(await db.query('SELECT * FROM mp_member_sets WHERE member_set_id=$1',[id])).rows[0];
/** The S1 input rows read like a service would, with the exit version the store derives (bridge-exit-v2 for the default artifact). */
async function rowsOf(world,exit='bridge-exit-v2'){
  const memberships=(await db.query(`SELECT m.pine_import_id,m.owner_id,m.bot_id,m.source_version,r.source_hash,m.connected,r.analysis FROM pine_memberships m
    JOIN pine_source_revisions r ON r.pine_import_id=m.pine_import_id AND r.source_version=m.source_version WHERE m.owner_id=$1 ORDER BY m.pine_import_id`,[world.id])).rows;
  const deployments=(await db.query('SELECT deployment_id,owner_id,bot_id,pine_import_id,source_version,state,snapshot,snapshot_hash FROM pine_deployments WHERE owner_id=$1 ORDER BY deployment_id',[world.id]))
    .rows.map(row=>({...row,exit_version:exit}));
  const evidence=(await db.query('SELECT e.deployment_id,e.snapshot_hash,e.evidence,e.evidence_hash FROM pine_bridge_evidence e JOIN pine_deployments d USING(deployment_id) WHERE d.owner_id=$1 ORDER BY e.deployment_id',[world.id])).rows;
  return {owner_id:world.id,bot_id:world.bot,bot_state:FIXED_STATE,memberships,deployments,evidence};
}
/** A database whose query() is tapped: on(sql, params, run) may act before or after run() or replace it. Everything else is the wrapped database. */
function tapped(target,on,watch){
  return {get isTransaction(){return target.isTransaction;},
    transaction:watch?async(fn,options)=>{try{return await target.transaction(fn,options);}catch(error){watch(error);throw error;}}:(fn,options)=>target.transaction(fn,options),prepare:sql=>target.prepare(sql),
    query:(sql,params)=>on(String(sql),params,()=>target.query(sql,params))};
}
const isParentInsert=sql=>/^INSERT INTO mp_member_sets\(/.test(sql.trim());
const isMemberInsert=sql=>/^INSERT INTO mp_member_set_members\(/.test(sql.trim());
const isMembershipLock=sql=>/FOR SHARE OF m/.test(sql);
const PARENT_SQL=`INSERT INTO public.mp_member_sets(member_set_id,owner_id,bot_id,version,pine_count,membership_hash,content_digest,set_hash,execution_model_hash,policy_hash,capital_basis_hash,
  funding_cutoff,bridge_atr_multiplier,bridge_rr,exit_version,same_bar_order,fixture,record,created_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`;
const MEMBER_SQL=`INSERT INTO public.mp_member_set_members(member_set_id,ordinal,owner_id,bot_id,pine_import_id,source_version,source_hash,effective_inputs_hash,deployment_id,deployment_snapshot_hash,
  exit_version,evidence_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`;
/** A competing writer: freezes the same content as another caller would, by hand, in its own SERIALIZABLE transaction. */
async function competitorFreezes(world,target=rt2){
  const built=buildMemberSet({...await rowsOf(world),fixture:true,member_set_id:randomUUID(),created_at:'2026-10-20T10:00:00Z',member_deployments:namesOf(world)});
  assert.equal(built.ok,true,JSON.stringify(built));
  const set=built.member_set;
  await target.transaction(async()=>{
    await target.query(PARENT_SQL,[set.member_set_id,set.owner_id,set.bot_id,set.version,set.pine_count,set.membership_hash,set.content_digest,set.set_hash,set.execution_model_hash,set.policy_hash,
      set.capital_basis_hash,set.funding_cutoff,set.bridge_pair.atr_multiplier,set.bridge_pair.rr,set.exit_version,set.same_bar_order,set.fixture,JSON.stringify(set),set.created_at]);
    for(const m of set.members)await target.query(MEMBER_SQL,[set.member_set_id,m.ordinal,set.owner_id,set.bot_id,m.pine_import_id,m.source_version,m.source_hash,m.effective_inputs_hash,m.deployment_id,
      m.deployment_snapshot_hash,m.exit_version,m.evidence_hash]);
  },{isolation:'SERIALIZABLE'});
  return set;
}
const refusedAs=(out,code,partial={})=>{
  assert.equal(out.ok,false,JSON.stringify(out));assert.equal(out.code,code,JSON.stringify(out));
  for(const [key,value] of Object.entries(partial))assert.deepEqual(out.diagnostic[key],value,key+': '+JSON.stringify(out.diagnostic));
};

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_mps_tpl_'+suffix;databaseName='robot_mps_main_'+suffix;roleName='robot_mps_rt_'+suffix.slice(0,14);
  await admin.query('CREATE ROLE '+roleName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    await install(builder,'pine-bridge-schema.sql');
    const report=await migrateMpMemberSet(builder);
    assert.equal(report.ok,true,report.failures?.join());
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  connectionString=urlOf(databaseName);
  db=track(new PostgresDatabase({connectionString,max:4}));
  await db.query(await grantScript(roleName));
  // The store opens its own SERIALIZABLE transaction: the runtime pools keep the default isolation level on purpose.
  rt=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:6}));
  rt2=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:6}));
  store=new Store(db);
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    for(const name of [...databases,databaseName,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    await admin.query('DROP ROLE IF EXISTS '+roleName).catch(()=>{});
    await admin.close();
  }
});

/* ---- 1. freeze and load ---- */

test('freeze then load: the first call freezes (one parent, one row per member, exit version derived from the artifact); the second loads the same set',async()=>{
  const world=await newWorld();
  const first=await call(world);
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.action,'FREEZE');
  const row=await stored(first.member_set.member_set_id);
  assert.deepEqual(row.record,first.member_set,'the stored record is the built record, verbatim');
  assert.deepEqual(await counts(world),{sets:1,members:2});
  assert.equal(first.member_set.exit_version,'bridge-exit-v2');assert.ok(first.member_set.members.every(m=>m.exit_version==='bridge-exit-v2'));
  assert.equal(row.exit_version,'bridge-exit-v2');assert.equal(row.fixture,true);assert.equal(row.pine_count,2);
  const digests=await allDigests();
  const second=await call(world);
  assert.equal(second.ok,true);assert.equal(second.action,'LOAD');assert.deepEqual(second.member_set,first.member_set);
  assert.notEqual(second.member_set.created_at,undefined);
  assert.deepEqual(await allDigests(),digests,'a load writes nothing');
  assert.deepEqual(await counts(world),{sets:1,members:2});
  // a caller-chosen id for the same content changes nothing: the stored set wins
  const third=await call(world,{member_set_id:randomUUID(),created_at:'2026-10-20T11:00:00Z'});
  assert.equal(third.action,'LOAD');assert.equal(third.member_set.member_set_id,first.member_set.member_set_id);
  // the loaded set is fresh against the same server rows, and a disconnect makes it stale (S1 freshness on a DB-stored set)
  const fresh=memberSetFreshness(second.member_set,await rowsOf(world));
  assert.deepEqual(fresh,{ok:true,fresh:true});
  await db.query('UPDATE pine_memberships SET connected=false WHERE pine_import_id=$1',[world.specs[1].pine]);
  const stale=memberSetFreshness(second.member_set,await rowsOf(world));
  assert.equal(stale.ok,true);assert.equal(stale.fresh,false);assert.equal(stale.diagnostic.field,'membership_hash');
});

test('freeze: three members, a Bot that is another user than the owner, and a bridge-exit-v1 artifact are stored as the artifact says',async()=>{
  const three=await newWorld({count:3,split:true});
  const out=await call(three);
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.action,'FREEZE');assert.equal(out.member_set.pine_count,3);
  assert.deepEqual(await counts(three),{sets:1,members:3});
  assert.notEqual(three.id,three.bot);assert.equal(out.member_set.owner_id,three.id);assert.equal(out.member_set.bot_id,three.bot);
  // the exit version comes from the artifact, not from any input: a v1 artifact freezes as v1 (the database knows both versions)
  const v1=await newWorld({artifact:a=>a.replaceAll('bridge-exit-v2','bridge-exit-v1')});
  const old=await call(v1);
  assert.equal(old.ok,true,JSON.stringify(old));assert.equal(old.member_set.exit_version,'bridge-exit-v1');
  assert.equal((await stored(old.member_set.member_set_id)).exit_version,'bridge-exit-v1');
  assert.deepEqual((await db.query('SELECT DISTINCT exit_version FROM mp_member_set_members WHERE member_set_id=$1',[old.member_set.member_set_id])).rows,[{exit_version:'bridge-exit-v1'}]);
});

test('race: callers that freeze the same content at the same moment end with one stored set and every caller holding it',async t=>{
  for(let round=0;round<4;round++){
    const world=await newWorld({count:round%2===0?2:3});
    const outs=await Promise.all([call(world,{},rt),call(world,{},rt2),call(world,{},rt),call(world,{},rt2)]);
    for(const out of outs)assert.equal(out.ok,true,'round '+round+': '+JSON.stringify(out));
    assert.equal(outs.filter(out=>out.action==='FREEZE').length,1,'round '+round+': '+outs.map(out=>out.action).join());
    assert.equal(new Set(outs.map(out=>out.member_set.member_set_id)).size,1,'one id for all callers');
    assert.deepEqual(await counts(world),{sets:1,members:world.specs.length});
    for(const out of outs)assert.deepEqual(out.member_set,outs[0].member_set);
    t.diagnostic('round '+round+': '+outs.map(out=>out.action).join());
  }
});

/* ---- 2. refusals write nothing ---- */

test('exit version: a missing, duplicate, foreign, failed or malformed generate job refuses with MP_INPUT_INVALID at the member, and S1 check order wins',async()=>{
  const OTHER='87654321-4321-4321-4321-cba987654321';
  const cases=[
    ['no job for member 2',{jobs:async(m,{add})=>{if(m.n!==2)await add({});}},2,'GENERATE_JOB_MISSING'],
    ['two succeeded jobs for member 1',{jobs:async(m,{add})=>{await add({});if(m.n===1)await add({});}},1,'GENERATE_JOB_DUPLICATE'],
    ['only a FAILED job for member 2',{jobs:async(m,{add})=>{await add({status:m.n===2?'FAILED':'SUCCEEDED'});}},2,'GENERATE_JOB_MISSING'],
    ['only a CANCELLED job for member 1',{jobs:async(m,{add})=>{await add({status:m.n===1?'CANCELLED':'SUCCEEDED'});}},1,'GENERATE_JOB_MISSING'],
    ['job of another Bot (same owner)',{split:true,jobs:async(m,{own,world,add})=>{await add(m.n===2?{bot:world.id}:{});}},2,'GENERATE_JOB_MISSING'],
    ['job of another owner (same Bot)',{split:true,jobs:async(m,{world,add})=>{await add(m.n===1?{owner:world.bot}:{});}},1,'GENERATE_JOB_MISSING'],
    ['job result names another deployment',{jobs:async(m,{own,add})=>{await add(m.n===2?{result:{integrated_pine:m.artifact,deployment_id:OTHER}}:{});}},2,'GENERATE_JOB_MISSING'],
    ['job result has no deployment_id',{jobs:async(m,{own,add})=>{await add(m.n===1?{result:{integrated_pine:m.artifact}}:{});}},1,'GENERATE_JOB_MISSING'],
    ['job artifact differs from the pinned hash',{jobArtifact:(a,m)=>m.n===2?a+' ':a},2,'ARTIFACT_HASH_MISMATCH'],
    ['job artifact is not a string',{jobs:async(m,{own,add})=>{await add(m.n===1?{result:{integrated_pine:7,deployment_id:m.dep}}:{});}},1,'ARTIFACT_NOT_STRING'],
    ['job result is null',{jobs:async(m,{add})=>{await add(m.n===1?{result:null}:{});}},1,'GENERATE_JOB_MISSING'],
    ['exit version the template never emitted',{artifact:(a,m)=>m.n===2?a.replaceAll('bridge-exit-v2','bridge-exit-v9'):a},2,'EXIT_VERSION_UNKNOWN'],
    ['alert prefix names another deployment',{artifact:(a,m)=>m.n===1?a.replace('\\"deployment_id\\":\\"'+m.dep,'\\"deployment_id\\":\\"'+OTHER):a},1,'ALERT_PREFIX_DEPLOYMENT_MISMATCH']];
  for(const [label,options,ordinal,reason] of cases){
    const world=await newWorld(options);
    const before=await allDigests();
    const out=await call(world);
    refusedAs(out,MP_CODES.INPUT_INVALID,{stage:'member',ordinal,field:'deployment.exit_version',reason,deployment_id:world.specs[ordinal-1].dep,pine_import_id:world.specs[ordinal-1].pine});
    assert.deepEqual(await allDigests(),before,label+': nothing written');
    assert.deepEqual(await counts(world),{sets:0,members:0},label);
  }
  // S1 order: a READY deployment without any job reports NOT_ELIGIBLE (an earlier S1 check), not the missing job
  const ready=await newWorld({jobs:async(m,{add})=>{if(m.n!==2)await add({});}});
  await db.query("UPDATE pine_deployments SET state='READY' WHERE deployment_id=$1",[ready.specs[1].dep]);
  refusedAs(await call(ready),MP_CODES.MEMBER_DEPLOYMENT_NOT_ELIGIBLE,{ordinal:2,state:'READY'});
  // mixed exit versions across members reach S1 and are refused there
  const mixed=await newWorld({artifact:(a,m)=>m.n===2?a.replaceAll('bridge-exit-v2','bridge-exit-v1'):a});
  refusedAs(await call(mixed),MP_CODES.EXIT_VERSION_MIXED,{field:'exit_version',ordinal:2});
  assert.deepEqual(await counts(mixed),{sets:0,members:0});
});

test('exit version fallbacks: when the probe build cannot name the member, the S1 refusal stays plain, with the derived reason only when exactly one deployment has one',async()=>{
  // The probe puts a placeholder exit version on every member. Member 2 has no Bridge evidence, so the probe fails behind member 1's defect.
  const one=await newWorld({jobs:async(m,{add})=>{if(m.n!==1)await add({});}});
  await db.query('DELETE FROM pine_bridge_evidence WHERE deployment_id=$1',[one.specs[1].dep]);
  const out=await call(one);
  refusedAs(out,MP_CODES.INPUT_INVALID,{field:'deployment 1.exit_version',reason:'GENERATE_JOB_MISSING',deployment_id:one.specs[0].dep});
  assert.equal(out.diagnostic.pine_import_id,undefined,'the member is not named: S1 could not name it');
  assert.equal(out.diagnostic.ordinal,undefined);
  assert.deepEqual(await counts(one),{sets:0,members:0});
  // Two deployments have a derived reason: nothing says which one S1 means, so the refusal is S1's own, with no reason and no deployment_id.
  const two=await newWorld({count:3,jobs:async(m,{add})=>{if(m.n===3)await add({});}});
  await db.query('DELETE FROM pine_bridge_evidence WHERE deployment_id=$1',[two.specs[2].dep]);
  const plain=await call(two);
  refusedAs(plain,MP_CODES.INPUT_INVALID,{field:'deployment 1.exit_version'});
  for(const key of ['reason','deployment_id','pine_import_id','ordinal'])assert.equal(plain.diagnostic[key],undefined,key);
  assert.deepEqual(await counts(two),{sets:0,members:0});
});

test('S1 refusals and caller defects reach the caller with no write: stale Bot state, missing evidence, foreign or unnamed deployments, bad input',async()=>{
  const before=await allDigests();
  // Bot state moved after the members were frozen: stale at birth
  const stale=await newWorld();
  refusedAs(await call(stale,{readBotState:async()=>({...FIXED_STATE,policy_hash:'f'.repeat(64)})}),MP_CODES.MEMBER_SET_STALE,{field:'policy_hash',against:'bot_state'});
  refusedAs(await call(stale,{readBotState:async()=>({...FIXED_STATE,funding_cutoff:8})}),MP_CODES.MEMBER_SET_STALE,{field:'funding_cutoff',against:'bot_state'});
  refusedAs(await call(stale,{readBotState:async()=>({policy_hash:'x'})}),MP_CODES.INPUT_INVALID,{field:'bot_state'});
  // Bridge evidence removed
  const noEvidence=await newWorld();
  await db.query('DELETE FROM pine_bridge_evidence WHERE deployment_id=$1',[noEvidence.specs[0].dep]);
  refusedAs(await call(noEvidence),MP_CODES.MEMBER_EVIDENCE_MISSING,{ordinal:1,reason:'absent'});
  // a single connected member is no multi-Pine set
  const single=await newWorld();
  await db.query('UPDATE pine_memberships SET connected=false WHERE pine_import_id=$1',[single.specs[1].pine]);
  refusedAs(await call(single),MP_CODES.NOT_MULTI_PINE,{pine_count:1});
  // deployments of another owner are never read: the name resolves to nothing
  const mine=await newWorld(),theirs=await newWorld();
  const foreign=mine.specs.map((m,i)=>({pine_import_id:m.pine,deployment_id:theirs.specs[i].dep}));
  refusedAs(await call(mine,{member_deployments:foreign}),MP_CODES.MEMBER_DEPLOYMENT_MISSING,{stage:'member',ordinal:1});
  refusedAs(await call(mine,{owner_id:theirs.id,bot_id:theirs.bot}),MP_CODES.INPUT_INVALID,{field:'member_deployments[0].pine_import_id'});
  // a member without a named deployment, and a name twice
  refusedAs(await call(mine,{member_deployments:namesOf(mine).slice(0,1)}),MP_CODES.MEMBER_DEPLOYMENT_MISSING,{ordinal:2});
  const twice=[...namesOf(mine),{pine_import_id:mine.specs[0].pine,deployment_id:theirs.specs[0].dep}];
  refusedAs(await call(mine,{member_deployments:twice}),MP_CODES.MEMBER_DEPLOYMENT_AMBIGUOUS,{ordinal:1});
  // an extra key in a member_deployments row reaches S1 unchanged and is refused there (closed key list); nothing is written
  const extra=await newWorld();
  const extraBefore=await allDigests();
  refusedAs(await call(extra,{member_deployments:namesOf(extra).map((row,i)=>i===0?{...row,exit_version:'bridge-exit-v2'}:row)}),MP_CODES.INPUT_INVALID,{field:'member_deployments[0]'});
  assert.deepEqual(await allDigests(),extraBefore,'extra key: nothing written');
  assert.deepEqual(await counts(extra),{sets:0,members:0});
  // input shape: unknown key, missing fixture, bad ids, no reader, a call inside a transaction
  const ok=await newWorld();
  refusedAs(await call(ok,{mode:'MULTI_PINE'}),MP_CODES.INPUT_INVALID,{field:'input.mode'});
  refusedAs(await call(ok,{fixture:undefined}),MP_CODES.FIXTURE_ONLY);
  refusedAs(await call(ok,{fixture:false}),MP_CODES.FIXTURE_ONLY);
  refusedAs(await call(ok,{member_set_id:'not-a-uuid'}),MP_CODES.INPUT_INVALID,{field:'member_set_id'});
  refusedAs(await call(ok,{created_at:'yesterday'}),MP_CODES.INPUT_INVALID,{field:'created_at'});
  refusedAs(await call(ok,{owner_id:''}),MP_CODES.INPUT_INVALID,{field:'owner_id'});
  refusedAs(await call(ok,{bot_id:7}),MP_CODES.INPUT_INVALID,{field:'bot_id'});
  refusedAs(await call(ok,{readBotState:undefined}),MP_CODES.INPUT_INVALID,{field:'readBotState'});
  refusedAs(await call(ok,{member_deployments:'x'}),MP_CODES.INPUT_INVALID,{field:'member_deployments'});
  refusedAs(await call(ok,{member_deployments:[{pine_import_id:'p'}]}),MP_CODES.INPUT_INVALID,{field:'member_deployments'});
  refusedAs(await freezeOrLoadMemberSet(rt,null),MP_CODES.INPUT_INVALID,{field:'input'});
  const nested=await rt.transaction(()=>call(ok),{isolation:'SERIALIZABLE'});
  refusedAs(nested,MP_CODES.INPUT_INVALID,{field:'db.transaction'});
  assert.deepEqual(await allDigests(),before,'no refusal left a row');
  for(const world of [stale,noEvidence,single,mine,theirs,ok])assert.deepEqual(await counts(world),{sets:0,members:0});
});

test('a stored record that no longer matches its digest is refused on load; nothing is added',async()=>{
  const world=await newWorld();
  const first=await call(world);
  assert.equal(first.action,'FREEZE');
  // The tables are insert-only for every role of the product; the database owner edits one record with the freeze trigger off to model a damaged row.
  await db.query('ALTER TABLE public.mp_member_sets DISABLE TRIGGER mp_member_sets_no_change');
  try{await db.query(`UPDATE public.mp_member_sets SET record=jsonb_set(record,'{members,0,effective_inputs_hash}',to_jsonb($2::text)) WHERE member_set_id=$1`,[first.member_set.member_set_id,'e'.repeat(64)]);}
  finally{await db.query('ALTER TABLE public.mp_member_sets ENABLE ALWAYS TRIGGER mp_member_sets_no_change');}
  const before=await allDigests();
  const again=await call(world);
  refusedAs(again,MP_CODES.INPUT_INVALID,{field:'existing[0].content_digest'});
  assert.deepEqual(await allDigests(),before);
  assert.deepEqual(await counts(world),{sets:1,members:2});
});

/* ---- 3. error map and retries (the database errors are real; the interleaving is injected) ---- */

test('40001 restarts from the beginning: two serialization failures retry and freeze; the retry bound is three',async()=>{
  assert.equal(MP_STORE_MAX_RETRIES,3);
  const world=await newWorld();
  let locks=0,hits=0;
  const concurrent=async()=>{await db.query('UPDATE pine_deployments SET created_at=created_at+1 WHERE deployment_id=$1',[world.specs[0].dep]);};
  const tap=tapped(rt,async(sql,params,run)=>{
    const out=await run();
    if(isMembershipLock(sql)){locks++;if(hits<2){hits++;await concurrent();}}
    return out;
  });
  const out=await call(world,{},tap);
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.action,'FREEZE');
  assert.equal(locks,3,'two failed attempts and one success');
  assert.deepEqual(await counts(world),{sets:1,members:2});
  // every attempt fails: first try plus three retries, then the last resort finds no stored set and the 40001 is rethrown; nothing is written
  const stuck=await newWorld();
  let attempts=0;
  const tapStuck=tapped(rt,async(sql,params,run)=>{
    const out=await run();
    if(isMembershipLock(sql)){attempts++;await db.query('UPDATE pine_deployments SET created_at=created_at+1 WHERE deployment_id=$1',[stuck.specs[0].dep]);}
    return out;
  });
  await assert.rejects(call(stuck,{},tapStuck),{code:'40001'});
  assert.equal(attempts,1+MP_STORE_MAX_RETRIES);
  assert.deepEqual(await counts(stuck),{sets:0,members:0});
  // the same stream of failures with the set already stored ends in a read-only load (RD-MP-15: retry a bounded number of times, then load)
  const frozen=await newWorld();
  const base=await call(frozen);
  assert.equal(base.action,'FREEZE');
  let more=0;
  const tapLoad=tapped(rt,async(sql,params,run)=>{
    const out=await run();
    if(isMembershipLock(sql)){more++;await db.query('UPDATE pine_deployments SET created_at=created_at+1 WHERE deployment_id=$1',[frozen.specs[0].dep]);}
    return out;
  });
  const loaded=await call(frozen,{},tapLoad);
  assert.equal(loaded.ok,true,JSON.stringify(loaded));assert.equal(loaded.action,'LOAD');assert.deepEqual(loaded.member_set,base.member_set);
  assert.equal(more,1+MP_STORE_MAX_RETRIES);
  assert.deepEqual(await counts(frozen),{sets:1,members:2});
});

test('a lost content-key race loads the winner, whether the database reports it as 40001, as 23505 or as an empty ON CONFLICT result',async t=>{
  const seen=[];
  // (a) the winner commits after our snapshot and before our parent INSERT: the real database error decides the path
  const raced=await newWorld();
  let winner,fired=false;
  const tapA=tapped(rt,async(sql,params,run)=>{
    if(isParentInsert(sql)&&!fired){fired=true;winner=await competitorFreezes(raced);}
    try{return await run();}catch(error){seen.push(error.code+':'+(error.constraint??''));throw error;}
  });
  const outA=await call(raced,{},tapA);
  assert.equal(outA.ok,true,JSON.stringify(outA));assert.equal(outA.action,'LOAD');assert.equal(outA.member_set.member_set_id,winner.member_set_id);
  assert.deepEqual(await counts(raced),{sets:1,members:2});
  assert.equal(seen.length,1,'one database error, then the load: '+seen.join());
  assert.ok(['40001:','23505:mp_member_sets_content_key'].includes(seen[0]),seen[0]);
  t.diagnostic('database error of a lost race: '+seen[0]);
  // (b) DO NOTHING returns no row (an equal set won): the re-select does not see it in this snapshot, so the attempt restarts and loads it
  const empty=await newWorld();
  let winnerB,parentInserts=0;
  const tapB=tapped(rt,async(sql,params,run)=>{
    if(isParentInsert(sql)){
      parentInserts++;
      if(parentInserts===1){winnerB=await competitorFreezes(empty);return {rows:[],rowCount:0};}
    }
    return run();
  });
  const outB=await call(empty,{},tapB);
  assert.equal(outB.ok,true,JSON.stringify(outB));assert.equal(outB.action,'LOAD');assert.equal(outB.member_set.member_set_id,winnerB.member_set_id);
  assert.equal(parentInserts,1,'the second attempt loads before it inserts');
  assert.deepEqual(await counts(empty),{sets:1,members:2});
  // (d) the database names the content key in a 23505 (a PostgreSQL that reports the race that way): load the winner as well
  const unique=await newWorld();
  let winnerD,thrown=0;
  const tapD=tapped(rt,async(sql,params,run)=>{
    if(isParentInsert(sql)&&thrown===0){thrown++;winnerD=await competitorFreezes(unique);throw Object.assign(new Error('duplicate key value violates unique constraint'),{code:'23505',constraint:'mp_member_sets_content_key'});}
    return run();
  });
  const outD=await call(unique,{},tapD);
  assert.equal(outD.ok,true,JSON.stringify(outD));assert.equal(outD.action,'LOAD');assert.equal(outD.member_set.member_set_id,winnerD.member_set_id);
  assert.deepEqual(await counts(unique),{sets:1,members:2});
  // (c) an empty result with nothing to load at all restarts and then freezes
  const nothing=await newWorld();
  let inserts=0;
  const tapC=tapped(rt,async(sql,params,run)=>{
    if(isParentInsert(sql)){inserts++;if(inserts===1)return {rows:[],rowCount:0};}
    return run();
  });
  const outC=await call(nothing,{},tapC);
  assert.equal(outC.ok,true,JSON.stringify(outC));assert.equal(outC.action,'FREEZE');assert.equal(inserts,2);
  assert.deepEqual(await counts(nothing),{sets:1,members:2});
});

test('QR004 maps to MP_MEMBER_SET_STALE with field insert_guard, from the member guard and from the deferred completeness guard',async()=>{
  // member guard: the deployment stops being DRAFT inside the transaction after the S1 checks passed
  const guard=await newWorld();
  const tapGuard=tapped(rt,async(sql,params,run)=>{
    if(isMemberInsert(sql))await rt.query("UPDATE pine_deployments SET state='READY' WHERE deployment_id=$1",[guard.specs[0].dep]);
    return run();
  });
  const before=await allDigests();
  const outGuard=await call(guard,{},tapGuard);
  refusedAs(outGuard,MP_CODES.MEMBER_SET_STALE,{stage:'store',field:'insert_guard',guard:'mp_member_set_members_guard'});
  // completeness guard (deferred, at COMMIT): a third connected membership appears inside the transaction, so pine_count no longer covers the Bot
  const complete=await newWorld();
  const tapComplete=tapped(rt,async(sql,params,run)=>{
    if(isMemberInsert(sql)){
      const extra=randomUUID(),hex=hash('extra-'+extra);
      await rt.query('INSERT INTO pine_sources VALUES($1,$2,$8,1,$3,$4,$5,$6,$7)',[extra,complete.id,hex,'Extra fixture','//@version=6\nindicator("e")','{}',T0,complete.bot]);
      await rt.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)',[extra,hex,'//@version=6\nindicator("e")','{}',T0]);
      await rt.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)',[extra,complete.id,complete.bot]);
    }
    return run();
  });
  const outComplete=await call(complete,{},tapComplete);
  refusedAs(outComplete,MP_CODES.MEMBER_SET_STALE,{stage:'store',field:'insert_guard',guard:'mp_member_sets_complete'});
  assert.deepEqual(await allDigests(),before,'both refusals rolled back');
  assert.equal((await db.query('SELECT count(*)::int n FROM pine_memberships WHERE owner_id=$1',[complete.id])).rows[0].n,2,'the tamper rolled back too');
  assert.equal((await db.query("SELECT state FROM pine_deployments WHERE deployment_id=$1",[guard.specs[0].dep])).rows[0].state,'DRAFT');
});

test('storage defects and unmapped errors: CHECK and other unique violations refuse with MP_INPUT_INVALID storage; anything else is rethrown; nothing is written',async()=>{
  const before=await allDigests();
  const check=await newWorld();
  const tapCheck=tapped(rt,async(sql,params,run)=>{
    if(isParentInsert(sql)){const changed=[...params];changed[4]=1;return rt.query(sql,changed);}
    return run();
  });
  const outCheck=await call(check,{},tapCheck);
  refusedAs(outCheck,MP_CODES.INPUT_INVALID,{stage:'store',field:'storage',sqlstate:'23514'});
  assert.match(outCheck.diagnostic.constraint,/^mp_member_sets_/);
  // a caller-chosen member_set_id that already names another set trips the primary key, not the content key
  const one=await newWorld(),two=await newWorld();
  const frozen=await call(one);
  assert.equal(frozen.action,'FREEZE');
  const clash=await call(two,{member_set_id:frozen.member_set.member_set_id});
  refusedAs(clash,MP_CODES.INPUT_INVALID,{stage:'store',field:'storage',sqlstate:'23505',constraint:'mp_member_sets_pkey'});
  assert.deepEqual(await counts(two),{sets:0,members:0});
  // a database error the map does not know is rethrown, after rollback
  const boom=await newWorld();
  const tapBoom=tapped(rt,async(sql,params,run)=>{
    if(isMemberInsert(sql))throw Object.assign(new Error('statement cancelled for the test'),{code:'57014'});
    return run();
  });
  await assert.rejects(call(boom,{},tapBoom),{code:'57014'});
  assert.deepEqual(await counts(boom),{sets:0,members:0});
  assert.deepEqual(await counts(check),{sets:0,members:0});
  assert.equal((await allDigests()).sets.n,before.sets.n+1,'only the one set of the primary key case was frozen');
});

test('retries: 40001 raised at COMMIT (a real SSI conflict) and 40P01 are retried within the bound; a 23505 on the member-row keys is storage, never a retry',async()=>{
  // (a) SSI conflict at COMMIT: a concurrent SERIALIZABLE transaction reads the member-set table (missing our uncommitted parent) and writes a job row
  // we read, then commits first. Our COMMIT is then the pivot of a dangerous structure and fails with 40001.
  const world=await newWorld();
  let parents=0,rival=0,rivalCommitted=false;const txErrors=[],queryErrors=[];
  const tapCommit=tapped(rt,async(sql,params,run)=>{
    if(isParentInsert(sql))parents++;
    let out;
    try{out=await run();}catch(error){queryErrors.push(error.code);throw error;}
    if(isMemberInsert(sql)&&rival++===0){
      await db.transaction(async()=>{
        await db.query('SELECT count(*)::int n FROM mp_member_sets WHERE owner_id=$1',[world.id]);
        await addJob(db,{owner:world.id,bot:world.bot,pine:world.specs[0].pine,dep:randomUUID(),result:{integrated_pine:'x',deployment_id:randomUUID()}});
      },{isolation:'SERIALIZABLE'});
      rivalCommitted=true;
    }
    return out;
  },error=>txErrors.push(error.code));
  const out=await call(world,{},tapCommit);
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.action,'FREEZE');
  assert.equal(rivalCommitted,true,'the rival committed, so the 40001 is ours, raised at COMMIT, and not the rival\'s');
  assert.deepEqual(txErrors,['40001'],'the first attempt failed with 40001');
  assert.deepEqual(queryErrors,[],'no statement failed: the 40001 came out of COMMIT');
  assert.equal(parents,2,'one failed attempt and one success');
  assert.deepEqual(await counts(world),{sets:1,members:2});
  // (b) 40P01 (deadlock) is retried like 40001, within the same bound
  const dead=await newWorld();
  let lockRuns=0;const deadErrors=[];
  const tapDead=tapped(rt,async(sql,params,run)=>{
    if(isMembershipLock(sql)&&++lockRuns<=2)throw Object.assign(new Error('deadlock detected'),{code:'40P01'});
    return run();
  },error=>deadErrors.push(error.code));
  const outDead=await call(dead,{},tapDead);
  assert.equal(outDead.ok,true,JSON.stringify(outDead));assert.equal(outDead.action,'FREEZE');
  assert.deepEqual(deadErrors,['40P01','40P01']);assert.equal(lockRuns,3);
  assert.deepEqual(await counts(dead),{sets:1,members:2});
  const doomed=await newWorld();
  let doomedRuns=0;
  const tapDoomed=tapped(rt,async(sql,params,run)=>{
    if(isMembershipLock(sql)){doomedRuns++;throw Object.assign(new Error('deadlock detected'),{code:'40P01'});}
    return run();
  });
  await assert.rejects(call(doomed,{},tapDoomed),{code:'40P01'});
  assert.equal(doomedRuns,1+MP_STORE_MAX_RETRIES,'first try plus three retries, then the last resort reads without a lock');
  assert.deepEqual(await counts(doomed),{sets:0,members:0});
  // (c) a real 23505 on a member-row unique key (the same member row twice) is a storage refusal: no retry, nothing written
  const dup=await newWorld();
  let dupParents=0;
  const tapDup=tapped(rt,async(sql,params,run)=>{
    if(isParentInsert(sql))dupParents++;
    const out=await run();
    if(isMemberInsert(sql))await run();
    return out;
  });
  const outDup=await call(dup,{},tapDup);
  refusedAs(outDup,MP_CODES.INPUT_INVALID,{stage:'store',field:'storage',sqlstate:'23505',constraint:'mp_member_set_members_pkey'});
  assert.equal(dupParents,1,'a storage defect is not retried');
  assert.deepEqual(await counts(dup),{sets:0,members:0});
});

/* ---- 4. the Bot state reader ---- */

test('the Bot state reads run inside the freeze transaction: same connection, same transaction id, SERIALIZABLE',async()=>{
  const capital=await new Store(rt).paperAccounts('any-bot');
  const world=await newWorld({snapshotBase:{policy:POLICY,policy_hash:hash(canonical(POLICY)),capital,funding_cutoff:0}});
  const probeSql="SELECT pg_backend_pid() pid,txid_current()::text xid,current_setting('transaction_isolation') iso,current_setting('transaction_read_only') ro";
  const probes=[];
  let main;
  // the Store sees the database through a spy: every statement it issues is preceded by a probe on the same (transaction) context
  const spy={get isTransaction(){return rt.isTransaction;},transaction:(fn,options)=>rt.transaction(fn,options),
    query:async(sql,params)=>{probes.push((await rt.query(probeSql)).rows[0]);return rt.query(sql,params);},
    prepare:sql=>{const inner=rt.prepare(sql);return {get:async(...p)=>{probes.push((await rt.query(probeSql)).rows[0]);return inner.get(...p);},
      all:async(...p)=>{probes.push((await rt.query(probeSql)).rows[0]);return inner.all(...p);},run:async(...p)=>{probes.push((await rt.query(probeSql)).rows[0]);return inner.run(...p);}};}};
  const reader=storeBotState({store:new Store(spy),defaultRisk:POLICY});
  const tapMain=tapped(rt,async(sql,params,run)=>{
    if(isMembershipLock(sql)&&main===undefined)main=(await rt.query(probeSql)).rows[0];
    return run();
  });
  let inside;
  const out=await call(world,{readBotState:async arg=>{inside=rt.isTransaction;return reader(arg);}},tapMain);
  assert.equal(out.ok,true,JSON.stringify(out));assert.equal(out.action,'FREEZE');
  assert.equal(inside,true,'the reader ran inside the transaction context');
  assert.ok(main&&main.iso==='serializable'&&main.ro==='off',JSON.stringify(main));
  assert.ok(probes.length>=3,'the reader issued several statements: '+probes.length);
  for(const probe of probes)assert.deepEqual(probe,main,'every Bot state read shares the freeze transaction (pid, xid, isolation)');
  assert.notEqual(main.pid,undefined);
  // outside the freeze the same reads use their own autocommit statements
  const outside=(await rt.query(probeSql)).rows[0];
  assert.notEqual(outside.xid,main.xid);
});

test('storeBotState reads the effective policy, the capital basis and the funding cutoff like freshSnapshot, inside the freeze transaction',async()=>{
  const DEFAULT={paperTrading:true,requireReduceOnlySell:true,maxRiskPercent:2};
  const runtimeStore=new Store(rt);
  const capital=await runtimeStore.paperAccounts('any-bot');
  const world=await newWorld({snapshotBase:{policy:DEFAULT,policy_hash:hash(canonical(DEFAULT)),capital,funding_cutoff:0}});
  const reader=storeBotState({store:runtimeStore,defaultRisk:DEFAULT});
  const state=await reader({bot_id:world.bot});
  assert.deepEqual(state,{policy_hash:hash(canonical(DEFAULT)),capital_basis_hash:hash(canonical(basis(capital))),funding_cutoff:0});
  const first=await call(world,{readBotState:reader});
  assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.action,'FREEZE');
  assert.equal(first.member_set.funding_cutoff,0);assert.equal(first.member_set.policy_hash,hash(canonical(DEFAULT)));
  assert.equal((await call(world,{readBotState:reader})).action,'LOAD');
  // a funding row (zero amounts, so only the cutoff moves) makes the Bot state differ from the frozen members
  await db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,0,0,'CONFIGURATION')",[world.bot,T0]);
  const moved=await call(world,{readBotState:reader});
  refusedAs(moved,MP_CODES.MEMBER_SET_STALE,{field:'funding_cutoff',against:'bot_state'});
  // a changed saved risk policy is stale too
  await db.query('INSERT INTO risk_profiles(user_id,policy,updated_at) VALUES($1,$2,$3)',[world.bot,JSON.stringify({maxRiskPercent:1}),T0]);
  const policy=await call(world,{readBotState:reader});
  refusedAs(policy,MP_CODES.MEMBER_SET_STALE,{field:'policy_hash',against:'bot_state'});
  assert.deepEqual(await counts(world),{sets:1,members:2});
});
