import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {migrateQuantFoundation} from '../../src/postgres/quant-foundation-migration.js';
import {canonical} from '../../src/pine-bridge/source.js';

// Local isolated PostgreSQL only. Every row below is a labeled test fixture, never evidence.
const sha256=text=>createHash('sha256').update(text,'utf8').digest('hex');
const BASE_FILES=['pine-bridge-schema.sql','quant-research-schema.sql'];
const FOUNDATION_FILES=['quant-foundation-schema.sql','quant-research-foundation-schema.sql','quant-storage-schema.sql'];
const NEW_TABLES=['quant_holdout_boundaries','quant_preflight_jobs','quant_preflight_schema'];
const NEW_FUNCTIONS=['quant_holdout_boundary_write_once','quant_preflight_jobs_guard'];
const MAX_TIME=253402300799999,MAX_ALIGNED=253402300740000;

let admin,shared;
const opened=[];
const sqlFile=name=>readFile(new URL('../../src/postgres/'+name,import.meta.url),'utf8');
async function createDatabase(foundationFiles=FOUNDATION_FILES){
  const name='preflight_schema_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+name);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
  const db=new PostgresDatabase({connectionString:url.toString()});
  opened.push({name,db});
  await db.migrate();
  for(const file of [...BASE_FILES,...foundationFiles])await db.query(await sqlFile(file));
  return db;
}
before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Isolated PostgreSQL required');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  shared=await createDatabase();
  await migrateQuantFoundation(shared);
});
after(async()=>{
  for(const {name,db} of opened.reverse()){await db.close();await admin.query('DROP DATABASE '+name);}
  await admin?.close();
});

async function identity(db){
  const id=randomUUID().slice(0,8),owner='pf-owner-'+id,bot='pf-bot-'+id,now=Date.now();
  await db.query("INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,'test-fixture-not-a-hash',$3)",[owner,owner+'@example.invalid',now]);
  await db.query("INSERT INTO users(id,email,password_hash,created_at,parent_user_id,bot_slot_index) VALUES($1,$2,'test-fixture-not-a-hash',$3,$4,2)",[bot,bot+'@example.invalid',now,owner]);
  return {owner,bot};
}
async function deployment(db,{owner,bot}){
  const importId='pf-import-'+randomUUID(),deploymentId='pf-deployment-'+randomUUID(),snapshot=canonical({test_fixture:true,nonce:deploymentId});
  await db.query('INSERT INTO pine_sources(pine_import_id,owner_id,bot_id,source_version,source_hash,source_name,source,analysis,created_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',
    [importId,owner,bot,sha256('// fixture'),'fixture','// fixture','{}',Date.now()]);
  await db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$3,$4,1,$5,$6,'READY',$7)",
    [deploymentId,owner,bot,importId,snapshot,sha256(snapshot),Date.now()]);
  return deploymentId;
}
async function foundationJob(db,owner,status='QUEUED'){
  const jobId=randomUUID(),contract=canonical({test_fixture:true,nonce:jobId}),now=Date.now();
  await db.query('INSERT INTO quant_foundation_owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
  await db.query('INSERT INTO quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [jobId,owner,'fixture:'+jobId,contract,sha256(contract),status,now,now+900000]);
  return jobId;
}
const COLUMNS=['job_id','owner_id','bot_id','plan_hash','plan_json','deployment_id','profile_job_id','created_at','unit_name','unit_token'];
const insertPreflight=(db,row)=>db.query('INSERT INTO quant_preflight_jobs('+COLUMNS.join(',')+') VALUES('+COLUMNS.map((_,i)=>'$'+(i+1)).join(',')+')',COLUMNS.map(name=>row[name]??null));
async function validRow(db,ids,deploymentId,overrides={}){
  const planJson=overrides.plan_json??canonical({version:'historical-preflight-v1',test_fixture:true,nonce:randomUUID()});
  return {job_id:await foundationJob(db,ids.owner),owner_id:ids.owner,bot_id:ids.bot,plan_hash:sha256(planJson),plan_json:planJson,
    deployment_id:deploymentId,profile_job_id:await foundationJob(db,ids.owner,'SUCCEEDED'),created_at:Date.now(),unit_name:null,unit_token:null,...overrides};
}
async function fixture(db=shared){
  const ids=await identity(db),deploymentId=await deployment(db,ids),row=await validRow(db,ids,deploymentId);
  await insertPreflight(db,row);
  return {ids,deploymentId,row};
}
const stored=async(db,jobId)=>(await db.query('SELECT '+COLUMNS.join(',')+' FROM quant_preflight_jobs WHERE job_id=$1',[jobId])).rows[0];
function violation(promise,{code,constraint,message}){
  return assert.rejects(promise,error=>{
    if(code)assert.equal(error.code,code);
    if(constraint)assert.equal(error.constraint,constraint);
    if(message)assert.match(error.message,message);
    return true;
  });
}
const checkViolation=(promise,constraint)=>violation(promise,{code:'23514',constraint});

const SCOPE={venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1'};
const MINUTE=60000,BOUNDARY=28333334*MINUTE;
async function insertHoldout(db,ids,value,overrides={}){
  const row={owner_id:ids.owner,bot_id:ids.bot,...SCOPE,holdout_start_time:value,created_by:ids.owner,created_at:Date.now(),...overrides};
  const names=Object.keys(row);
  return db.query('INSERT INTO quant_holdout_boundaries('+names.join(',')+') VALUES('+names.map((_,i)=>'$'+(i+1)).join(',')+')',names.map(name=>row[name]));
}
const boundaryRows=async(db,ids)=>(await db.query('SELECT * FROM quant_holdout_boundaries WHERE owner_id=$1 AND bot_id=$2',[ids.owner,ids.bot])).rows;

test('holdout boundary stores one minute aligned value for the fixed BINANCE:BTCUSDT Spot 1m scope',async()=>{
  const ids=await identity(shared);
  await insertHoldout(shared,ids,BOUNDARY);
  const rows=await boundaryRows(shared,ids);
  assert.equal(rows.length,1);
  assert.deepEqual({...rows[0],created_at:undefined},{owner_id:ids.owner,bot_id:ids.bot,...SCOPE,holdout_start_time:BOUNDARY,created_by:ids.owner,created_at:undefined});
  // Another bot (and another owner) registers independently, even for the same value.
  const other=await identity(shared);
  await insertHoldout(shared,other,BOUNDARY);
  assert.equal((await boundaryRows(shared,other)).length,1);
});

test('holdout boundary is write-once: same or different value conflicts, UPDATE and DELETE are rejected',async()=>{
  const ids=await identity(shared);
  await insertHoldout(shared,ids,BOUNDARY);
  const before=await boundaryRows(shared,ids);
  await violation(insertHoldout(shared,ids,BOUNDARY),{code:'23505',constraint:'quant_holdout_boundaries_pkey'});
  await violation(insertHoldout(shared,ids,BOUNDARY+MINUTE),{code:'23505',constraint:'quant_holdout_boundaries_pkey'});
  const insert='INSERT INTO quant_holdout_boundaries(owner_id,bot_id,venue,market,symbol,timeframe,holdout_start_time,created_by,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)';
  const values=(time)=>[ids.owner,ids.bot,SCOPE.venue,SCOPE.market,SCOPE.symbol,SCOPE.timeframe,time,ids.owner,Date.now()];
  // The idempotent API path may skip a conflicting insert, but it can never overwrite.
  assert.equal((await shared.query(insert+' ON CONFLICT DO NOTHING',values(BOUNDARY+MINUTE))).rowCount,0);
  await violation(shared.query(insert+' ON CONFLICT ON CONSTRAINT quant_holdout_boundaries_pkey DO UPDATE SET holdout_start_time=EXCLUDED.holdout_start_time',values(BOUNDARY+MINUTE)),{code:'P0001',message:/write-once/});
  const where=' WHERE owner_id=$1 AND bot_id=$2';
  await violation(shared.query('UPDATE quant_holdout_boundaries SET holdout_start_time=$3'+where,[ids.owner,ids.bot,BOUNDARY+MINUTE]),{code:'P0001',message:/write-once/});
  await violation(shared.query('UPDATE quant_holdout_boundaries SET holdout_start_time=holdout_start_time'+where,[ids.owner,ids.bot]),{code:'P0001',message:/write-once/});
  await violation(shared.query("UPDATE quant_holdout_boundaries SET created_by='someone-else'"+where,[ids.owner,ids.bot]),{code:'P0001',message:/write-once/});
  await violation(shared.query('DELETE FROM quant_holdout_boundaries'+where,[ids.owner,ids.bot]),{code:'P0001',message:/write-once/});
  assert.deepEqual(await boundaryRows(shared,ids),before);
});

test('holdout boundary CHECK requires minute alignment and 0 < value <= 253402300799999',async()=>{
  const constraint='quant_holdout_boundaries_holdout_start_time_check';
  const ids=await identity(shared);
  for(const value of [1,59999,60001,BOUNDARY+1,MAX_TIME,0,-MINUTE,-1,MAX_ALIGNED+MINUTE,MAX_ALIGNED+MINUTE*2])
    await checkViolation(insertHoldout(shared,ids,value),constraint);
  await violation(insertHoldout(shared,ids,null),{code:'23502'});
  assert.equal((await boundaryRows(shared,ids)).length,0);
  await insertHoldout(shared,ids,MINUTE);
  const top=await identity(shared);
  await insertHoldout(shared,top,MAX_ALIGNED);
  assert.equal((await boundaryRows(shared,top))[0].holdout_start_time,MAX_ALIGNED);
});

test('holdout boundary scope is fixed to binance-global SPOT BTCUSDT 1',async()=>{
  const ids=await identity(shared);
  const cases={venue:['binance-us','BINANCE-GLOBAL','',' binance-global'],market:['FUTURES','spot','MARGIN'],symbol:['ETHUSDT','btcusdt','BTCUSDT '],timeframe:['5','1m','01','']};
  for(const [column,values] of Object.entries(cases))
    for(const value of values)await checkViolation(insertHoldout(shared,ids,BOUNDARY,{[column]:value}),'quant_holdout_boundaries_'+column+'_check');
  for(const column of Object.keys(SCOPE))await violation(insertHoldout(shared,ids,BOUNDARY,{[column]:null}),{code:'23502'});
  assert.equal((await boundaryRows(shared,ids)).length,0);
});

test('holdout boundary foreign keys reject unknown owner or bot and protect referenced users',async()=>{
  const ids=await identity(shared);
  await violation(insertHoldout(shared,ids,BOUNDARY,{owner_id:'pf-missing-owner'}),{code:'23503',constraint:'quant_holdout_boundaries_owner_id_fkey'});
  await violation(insertHoldout(shared,ids,BOUNDARY,{bot_id:'pf-missing-bot'}),{code:'23503',constraint:'quant_holdout_boundaries_bot_id_fkey'});
  await insertHoldout(shared,ids,BOUNDARY);
  await violation(shared.query('DELETE FROM users WHERE id=$1',[ids.bot]),{code:'23503',constraint:'quant_holdout_boundaries_bot_id_fkey'});
});

const PLAN_CHECK='quant_preflight_jobs_plan_sha_check';
test('plan_json CHECK accepts the exact canonical UTF-8 bytes',async()=>{
  const {ids,deploymentId}=await fixture();
  // One literal backslash (two in this source, one in the value) that canonical JSON writes as two. Nothing else in
  // the text needs a backslash escape, so a ::bytea cast would not fail on the text but would hash other bytes.
  const backslashOnly=canonical({version:'historical-preflight-v1',path:'a\\b'});
  assert.equal([...backslashOnly].filter(character=>character==='\\').length,2);
  const plans=[
    canonical({version:'historical-preflight-v1',foundation:{kind:'PREFLIGHT',budget:{candidates:1}},snapshot:{signal:{mode:'EVALUATOR'}}}),
    canonical({note:'caf\u00e9 \u4e2d\u6587 \ud83d\ude00',version:'historical-preflight-v1'}),
    // The canonical bytes hold a double quote, a backslash and an escaped control character. The CHECK hashes
    // convert_to(plan_json,'UTF8'), the exact stored text bytes; a ::bytea cast would reject or reinterpret them (R2 audit A1).
    canonical({version:'historical-preflight-v1',title:'say "hi"',path:'a\\b',note:'a\nb'}),
    backslashOnly,
    '{}',
    canonical({padding:'x'.repeat(300000)})
  ];
  for(const planJson of plans){
    const row=await validRow(shared,ids,deploymentId,{plan_json:planJson});
    await insertPreflight(shared,row);
    const read=await stored(shared,row.job_id);
    assert.ok(Buffer.from(read.plan_json,'utf8').equals(Buffer.from(planJson,'utf8')));
    assert.equal(read.plan_hash,sha256(planJson));
  }
});

test('plan_json CHECK rejects every byte sequence other than the hashed canonical one',async()=>{
  const {ids,deploymentId}=await fixture();
  const object={b:[1,2],a:{y:'caf\u00e9',x:true},version:'historical-preflight-v1'};
  const plan=canonical(object);
  const latin1=createHash('sha256').update(Buffer.from(plan,'latin1')).digest('hex');
  assert.notEqual(latin1,sha256(plan));
  const cases={
    'trailing newline':[plan,sha256(plan+'\n')],
    'plan gained a trailing newline':[plan+'\n',sha256(plan)],
    'plan gained CRLF':[plan+'\r\n',sha256(plan)],
    'leading space':[' '+plan,sha256(plan)],
    'pretty printed':[JSON.stringify(object,null,1),sha256(plan)],
    'hash of pretty printed':[plan,sha256(JSON.stringify(object,null,1))],
    'reordered keys':['{"b":[1,2],"a":{"y":"caf\u00e9","x":true},"version":"historical-preflight-v1"}',sha256(plan)],
    'latin1 bytes':[plan,latin1],
    'hash of empty text':[plan,sha256('')],
    'hash of another plan':[plan,sha256(canonical({other:true}))]
  };
  for(const [label,[planJson,planHash]] of Object.entries(cases)){
    const row=await validRow(shared,ids,deploymentId,{plan_json:planJson,plan_hash:planHash});
    await assert.rejects(insertPreflight(shared,row),error=>{assert.equal(error.code,'23514',label);assert.equal(error.constraint,PLAN_CHECK,label);return true;},label);
    assert.equal(await stored(shared,row.job_id),undefined,label);
  }
});

test('plan_hash must be 64 lowercase hex characters and neither column may be NULL',async()=>{
  const {ids,deploymentId}=await fixture();
  const plan=canonical({version:'historical-preflight-v1'}),good=sha256(plan);
  for(const planHash of [good.toUpperCase(),good.slice(1),good+'0','g'.repeat(64),good+'\n',' '+good,''])
    await assert.rejects(insertPreflight(shared,await validRow(shared,ids,deploymentId,{plan_json:plan,plan_hash:planHash})),
      error=>{assert.equal(error.code,'23514');assert.match(error.constraint,/^quant_preflight_jobs_plan_(hash|sha)_check$/);return true;});
  await violation(insertPreflight(shared,await validRow(shared,ids,deploymentId,{plan_json:plan,plan_hash:null})),{code:'23502'});
  await violation(insertPreflight(shared,await validRow(shared,ids,deploymentId,{plan_json:null})),{code:'23502'});
});

test('unit_name and unit_token are set and cleared as a pair',async()=>{
  const {ids,deploymentId}=await fixture();
  const pairCheck='quant_preflight_jobs_unit_pair_check';
  await checkViolation(insertPreflight(shared,await validRow(shared,ids,deploymentId,{unit_name:'robot-quant-test.service'})),pairCheck);
  await checkViolation(insertPreflight(shared,await validRow(shared,ids,deploymentId,{unit_token:randomUUID()})),pairCheck);
  await violation(insertPreflight(shared,await validRow(shared,ids,deploymentId,{unit_name:'robot-quant-test.service',unit_token:'not-a-uuid'})),{code:'22P02'});
  const both=await validRow(shared,ids,deploymentId,{unit_name:'robot-quant-test.service',unit_token:randomUUID()});
  await insertPreflight(shared,both);
  const {job_id:jobId}=both;
  await checkViolation(shared.query('UPDATE quant_preflight_jobs SET unit_token=NULL WHERE job_id=$1',[jobId]),pairCheck);
  await checkViolation(shared.query('UPDATE quant_preflight_jobs SET unit_name=NULL WHERE job_id=$1',[jobId]),pairCheck);
  assert.deepEqual(await stored(shared,jobId),both);
});

test('preflight job binding is immutable; only the unit pair changes',async()=>{
  const {ids,deploymentId,row}=await fixture();
  const otherDeployment=await deployment(shared,ids),otherJob=await foundationJob(shared,ids.owner),otherProfile=await foundationJob(shared,ids.owner,'SUCCEEDED');
  const otherPlan=canonical({version:'historical-preflight-v1',other:true});
  const change=(assignments,values)=>shared.query('UPDATE quant_preflight_jobs SET '+assignments+' WHERE job_id=$1',[row.job_id,...values]);
  const attempts=[
    ['job_id=$2',[otherJob]],['owner_id=$2',['pf-other-owner']],['bot_id=$2',['pf-other-bot']],
    ['plan_hash=$2',[sha256(otherPlan)]],['plan_json=$2',[otherPlan]],['plan_hash=$2,plan_json=$3',[sha256(otherPlan),otherPlan]],
    ['deployment_id=$2',[otherDeployment]],['profile_job_id=$2',[otherProfile]],['created_at=$2',[row.created_at+1]],
    ['job_id=$2,owner_id=$3,unit_name=$4,unit_token=$5',[otherJob,'pf-other-owner','robot-quant-x.service',randomUUID()]]
  ];
  for(const [assignments,values] of attempts)
    await violation(change(assignments,values),{code:'P0001',message:/immutable/});
  assert.deepEqual(await stored(shared,row.job_id),row);
  // The unit pair may be set, replaced and cleared; an update that keeps the binding is accepted.
  const first={name:'robot-quant-'+randomUUID()+'.service',token:randomUUID()},second={name:'robot-quant-'+randomUUID()+'.service',token:randomUUID()};
  await change('unit_name=$2,unit_token=$3',[first.name,first.token]);
  assert.deepEqual(await stored(shared,row.job_id),{...row,unit_name:first.name,unit_token:first.token});
  await change('unit_name=$2,unit_token=$3',[second.name,second.token]);
  await change('unit_name=unit_name',[]);
  assert.deepEqual(await stored(shared,row.job_id),{...row,unit_name:second.name,unit_token:second.token});
  await change('unit_name=NULL,unit_token=NULL',[]);
  assert.deepEqual(await stored(shared,row.job_id),row);
  assert.equal(deploymentId,row.deployment_id);
});

test('preflight job rows cannot be deleted',async()=>{
  const {row}=await fixture();
  await violation(shared.query('DELETE FROM quant_preflight_jobs WHERE job_id=$1',[row.job_id]),{code:'P0001',message:/cannot be deleted/});
  await shared.query("UPDATE quant_preflight_jobs SET unit_name='robot-quant-x.service',unit_token=$2 WHERE job_id=$1",[row.job_id,randomUUID()]);
  await violation(shared.query('DELETE FROM quant_preflight_jobs WHERE job_id=$1',[row.job_id]),{code:'P0001',message:/cannot be deleted/});
  assert.equal((await stored(shared,row.job_id)).plan_hash,row.plan_hash);
});

test('preflight job foreign keys: job, deployment and profile job must exist and stay referenced',async()=>{
  const {ids,deploymentId,row}=await fixture();
  const fresh=(overrides)=>validRow(shared,ids,deploymentId,overrides);
  await violation(insertPreflight(shared,await fresh({job_id:randomUUID()})),{code:'23503',constraint:'quant_preflight_jobs_job_id_fkey'});
  await violation(insertPreflight(shared,await fresh({deployment_id:'pf-missing-deployment'})),{code:'23503',constraint:'quant_preflight_jobs_deployment_id_fkey'});
  await violation(insertPreflight(shared,await fresh({profile_job_id:randomUUID()})),{code:'23503',constraint:'quant_preflight_jobs_profile_job_id_fkey'});
  await violation(insertPreflight(shared,await fresh({job_id:row.job_id})),{code:'23505',constraint:'quant_preflight_jobs_pkey'});
  // Referenced evidence cannot be removed while a preflight job points at it.
  await violation(shared.query('DELETE FROM quant_foundation_jobs WHERE job_id=$1',[row.profile_job_id]),{code:'23503',constraint:'quant_preflight_jobs_profile_job_id_fkey'});
  await violation(shared.query('DELETE FROM quant_foundation_jobs WHERE job_id=$1',[row.job_id]),{code:'23503',constraint:'quant_preflight_jobs_job_id_fkey'});
  await violation(shared.query('DELETE FROM pine_deployments WHERE deployment_id=$1',[deploymentId]),{code:'23503',constraint:'quant_preflight_jobs_deployment_id_fkey'});
  assert.deepEqual(await stored(shared,row.job_id),row);
});

test('column types and the owner/bot/created_at index match the contract',async()=>{
  const types=async(table)=>Object.fromEntries((await shared.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[table])).rows.map(r=>[r.column_name,r.data_type+(r.is_nullable==='NO'?' not null':'')]));
  assert.deepEqual(await types('quant_preflight_jobs'),{job_id:'uuid not null',owner_id:'text not null',bot_id:'text not null',plan_hash:'text not null',plan_json:'text not null',
    deployment_id:'text not null',profile_job_id:'uuid not null',created_at:'bigint not null',unit_name:'text',unit_token:'uuid'});
  assert.deepEqual(await types('quant_holdout_boundaries'),{owner_id:'text not null',bot_id:'text not null',venue:'text not null',market:'text not null',symbol:'text not null',
    timeframe:'text not null',holdout_start_time:'bigint not null',created_by:'text not null',created_at:'bigint not null'});
  assert.deepEqual(await types('quant_preflight_schema'),{version:'integer not null'});
  const index=(await shared.query("SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='quant_preflight_jobs' AND indexname='quant_preflight_jobs_bot'")).rows[0];
  assert.match(index.indexdef,/\(owner_id, bot_id, created_at DESC\)/);
});

const relationOids=async(db)=>Object.fromEntries((await db.query(
  "SELECT c.relname,c.oid::text oid FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname = ANY($1) ORDER BY 1",
  [[...NEW_TABLES,'quant_preflight_jobs_bot','quant_preflight_jobs_pkey','quant_holdout_boundaries_pkey']])).rows.map(r=>[r.relname,r.oid]));
const preflightTriggers=async(db)=>(await db.query(
  "SELECT tgname,tgrelid::regclass::text relation,pg_get_triggerdef(oid) def FROM pg_trigger WHERE NOT tgisinternal AND tgrelid = ANY($1::regclass[]) ORDER BY tgname",
  [['quant_holdout_boundaries','quant_preflight_jobs']])).rows;

test('migration installs the preflight schema once and a second run changes nothing',async()=>{
  const db=await createDatabase([]);
  assert.equal((await db.query("SELECT to_regclass('quant_preflight_schema') present")).rows[0].present,null);
  assert.equal(await migrateQuantFoundation(db),'LEGACY');
  assert.deepEqual((await db.query('SELECT version FROM quant_preflight_schema')).rows,[{version:1}]);
  const oids=await relationOids(db),triggers=await preflightTriggers(db);
  assert.equal(Object.keys(oids).length,6);
  assert.deepEqual(triggers.map(t=>t.tgname),['quant_holdout_boundary_write_once','quant_preflight_jobs_guard']);
  const ids=await identity(db);
  await insertHoldout(db,ids,BOUNDARY);
  assert.equal(await migrateQuantFoundation(db),'LEGACY');
  assert.equal(await migrateQuantFoundation(db,{mode:'FOUNDATION'}),'FOUNDATION');
  assert.equal(await migrateQuantFoundation(db,{mode:'LEGACY'}),'LEGACY');
  assert.deepEqual((await db.query('SELECT version FROM quant_preflight_schema')).rows,[{version:1}]);
  assert.deepEqual(await relationOids(db),oids);
  assert.deepEqual(await preflightTriggers(db),triggers);
  assert.equal((await boundaryRows(db,ids))[0].holdout_start_time,BOUNDARY);
  // The version table is a singleton pinned to 1.
  await violation(db.query('INSERT INTO quant_preflight_schema VALUES(1)'),{code:'23505'});
  await violation(db.query('INSERT INTO quant_preflight_schema VALUES(2)'),{code:'23514'});
});

test('migration refuses an unsupported preflight version state and never half-installs',async()=>{
  const db=await createDatabase();
  await migrateQuantFoundation(db);
  await db.query('DELETE FROM quant_preflight_schema');
  await assert.rejects(migrateQuantFoundation(db),/Unsupported quant_preflight_schema version/);
  await db.query('INSERT INTO quant_preflight_schema VALUES(1)');
  assert.equal(await migrateQuantFoundation(db),'LEGACY');

  // A name clash inside the new SQL rolls the whole migration back, including the version table.
  const clash=await createDatabase();
  await clash.query('CREATE TABLE quant_holdout_boundaries(unrelated INTEGER)');
  await assert.rejects(migrateQuantFoundation(clash),error=>error.code==='42P07');
  const present=(await clash.query("SELECT to_regclass('quant_preflight_schema') schema_table,to_regclass('quant_preflight_jobs') jobs_table")).rows[0];
  assert.deepEqual(present,{schema_table:null,jobs_table:null});
  assert.deepEqual((await clash.query("SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname = ANY($1)",[NEW_FUNCTIONS])).rows,[]);
});

async function catalogSnapshot(db){
  const names=(await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1")).rows.map(r=>r.table_name);
  const tables={};
  for(const name of names){
    const rows=(sql)=>db.query(sql,[name]).then(result=>result.rows);
    tables[name]={
      columns:await rows("SELECT column_name,ordinal_position,data_type,udt_name,is_nullable,column_default,character_maximum_length,is_identity FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position"),
      constraints:await rows("SELECT conname,contype,pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid=('public.'||quote_ident($1))::regclass ORDER BY conname"),
      indexes:await rows("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1 ORDER BY indexname"),
      // Internal referential triggers are excluded: PostgreSQL adds them to every table a new foreign key points at.
      triggers:await rows("SELECT tgname,pg_get_triggerdef(oid) def FROM pg_trigger WHERE tgrelid=('public.'||quote_ident($1))::regclass AND NOT tgisinternal ORDER BY tgname"),
      content:(await db.query('SELECT count(*)::int n,md5(COALESCE(string_agg(x::text,\'|\' ORDER BY x::text),\'\')) digest FROM public."'+name+'" x')).rows[0]
    };
  }
  const functions=(await db.query("SELECT proname,pg_get_functiondef(oid) def FROM pg_proc WHERE pronamespace='public'::regnamespace AND prokind='f' ORDER BY proname")).rows;
  return {tables,functions};
}

test('migration adds only the three preflight tables and two functions; existing tables are untouched',async()=>{
  const db=await createDatabase();
  const ids=await identity(db);
  await deployment(db,ids);
  await foundationJob(db,ids.owner,'SUCCEEDED');
  assert.equal((await db.query("SELECT to_regclass('quant_holdout_boundaries') present")).rows[0].present,null);
  const before=await catalogSnapshot(db);
  assert.ok(before.tables.quant_foundation_jobs.content.n>0&&before.tables.pine_deployments.content.n>0&&before.tables.users.content.n>0);
  assert.equal(await migrateQuantFoundation(db),'LEGACY');
  const after=await catalogSnapshot(db);
  const added=Object.keys(after.tables).filter(name=>!before.tables[name]).sort();
  assert.deepEqual(added,[...NEW_TABLES].sort());
  for(const [name,snapshot] of Object.entries(before.tables))assert.deepEqual(after.tables[name],snapshot,'existing table changed: '+name);
  assert.deepEqual(after.functions.filter(f=>!NEW_FUNCTIONS.includes(f.proname)),before.functions);
  assert.deepEqual(after.functions.filter(f=>NEW_FUNCTIONS.includes(f.proname)).map(f=>f.proname),[...NEW_FUNCTIONS].sort());
  assert.equal((await db.query('SELECT version FROM schema_version')).rows[0].version,14);
});
