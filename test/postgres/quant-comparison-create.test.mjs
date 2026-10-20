import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {INSERT_GUARD_SQLSTATE,SERIALIZABLE_SQLSTATE,migrateQuantComparison,classifyQuantComparison} from '../../src/postgres/quant-comparison-migration.js';
import {migrateQuantExposureRegister} from '../../src/postgres/quant-exposure-register-migration.js';
import {appendExposures,readExposures,EXPOSURE_CODES} from '../../src/postgres/exposure-register.js';
import {createComparison,readComparison,requestKeyHash,MAX_RETRIES,STORE_CODES} from '../../src/postgres/comparison-store.js';
import {validateSpec,specHashOf} from '../../src/comparison/ranking.js';
import {CODES} from '../../src/comparison/common.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {hex,MINUTE,T0} from '../helpers/quant-library-fixture.mjs';

// QR-3 S2c-1 create path and owner read (src/postgres/comparison-store.js), proven on a throwaway PostgreSQL cluster as a real non-owner LOGIN role with
// the repo grants. Every row is a LABELLED FIXTURE (synthetic, never a research result). Rows are insert-only, so each test uses its own owner or ids.
const QR003=SERIALIZABLE_SQLSTATE,QR004=INSERT_GUARD_SQLSTATE,SERIALIZATION_FAILURE='40001';
const COMPLETE_GUARD='quant_comparison_create_complete',TRANSITION_GUARD='quant_comparison_status_transition';
const MARKET={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
const SPECS='public.quant_comparison_specs',PARTICIPANTS='public.quant_comparison_participants',EVENTS='public.quant_comparison_status_events',REGISTER='public.quant_exposure_register';
const serializable={isolation:'SERIALIZABLE'};
let admin,db,rt,rt2,connectionString,templateName,databaseName,roleName,store;
const databases=[],pools=[];
const urlOf=(name,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;if(user)url.username=user;return url.toString();};
const sqlText=name=>fs.readFile(new URL(name,new URL('../../src/postgres/',import.meta.url)),'utf8');
const install=async(target,name)=>target.transaction(async()=>target.query(await sqlText(name)));
const grantPath=fileURLToPath(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url));
const grantScript=async role=>(await fs.readFile(grantPath,'utf8')).replaceAll(":'runtime_role'","'"+role+"'");
const refusedBy=(promise,code,constraint)=>assert.rejects(promise,error=>error.code===code&&error.constraint===constraint);
const track=pool=>{pools.push(pool);return pool;};
const gate=()=>{let open;const promise=new Promise(resolve=>{open=resolve;});return {promise,open};};
async function until(check,label,timeout=10000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw Error('timed out waiting for '+label);
}
const rowDigest=async(target,table)=>(await target.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM ${table} t`)).rows[0];
const allRows=async target=>Promise.all([SPECS,PARTICIPANTS,EVENTS,REGISTER].map(table=>rowDigest(target,table)));
const dbClock=async target=>Number((await target.query("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0].now);

/** A database cloned from the template (base schema 14, Pine and research extensions, register and comparison tables). */
async function clone(label){
  const name='robot_s2cc_'+label+'_'+randomUUID().replaceAll('-','').slice(0,20);databases.push(name);
  await admin.query('CREATE DATABASE '+name+' TEMPLATE '+templateName);
  return name;
}
/** A runtime-role pool on a clone, after the repo grants. */
async function runtimeOn(name){
  const owner=track(new PostgresDatabase({connectionString:urlOf(name),max:3}));
  await owner.query(await grantScript(roleName));
  return {owner,runtime:track(new PostgresDatabase({connectionString:urlOf(name,roleName),max:4}))};
}
async function newOwner(label,target=store){
  const user=await target.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'unused-fixture-hash'});
  return user.id;
}

/** A recording wrapper around a database handle: every query is logged, and a test may delay it, replace its answer or make it throw. */
function spy(target,{before=null,answer=null}={}){
  const log=[];
  const proxy=new Proxy(target,{get(object,property){
    if(property==='query')return async(sql,params)=>{
      const text=String(sql);log.push(text);
      if(before)await before(text,log.length);
      const replaced=answer?answer(text,params):undefined;
      return replaced!==undefined?replaced:object.query(sql,params);
    };
    const value=object[property];
    return typeof value==='function'?value.bind(object):value;
  }});
  return {db:proxy,log};
}
/** A handle that must never be touched: any use means the request was not refused before the database. */
const untouchable=()=>({isTransaction:false,query(){throw Error('query on a refused request');},transaction(){throw Error('transaction on a refused request');}});

const WINDOW0={start_ms:T0,end_ms:T0+1440*MINUTE};
let windowShift=0;
const nextWindow=()=>{windowShift+=1;return {start_ms:WINDOW0.start_ms+windowShift*2*1440*MINUTE,end_ms:WINDOW0.end_ms+windowShift*2*1440*MINUTE};};
function specFor(ids,window,patch={}){
  const checked=validateSpec({mode:'STANDARDIZED',participants:ids,period:{start_ms:window.start_ms,end_ms:window.end_ms},objective:'qr3-obj-net-return-v1',risk_filter:{max_drawdown_percent:'20'},
    adequacy:{min_episodes_floor:5,min_episodes_ranking:20},tie:{band_pp:'0.50'},benchmark:'qr3-bh-close-same-cost-v1',
    uncertainty:{method:'qr3-unc-paired-daily-block-bootstrap-v1',seed:'seed-1',resamples:200,block_length:2,confidence:'0.95'},...patch});
  assert.equal(checked.ok,true,JSON.stringify(checked));
  return checked;
}
/** createComparison input. ids and window can be fixed to build overlapping comparisons; every default is fresh. */
function inputFor(owner,{ids=null,count=2,window=null,fixture=true,origin=fixture?'FIXTURE':'LIBRARY_RUN',patch={}}={}){
  const w=window??nextWindow();
  const list=ids??Array.from({length:count},(_,index)=>'run-'+randomUUID().slice(0,8)+'-'+index);
  const checked=specFor(list,w);
  return {owner_id:owner,market:{...MARKET},fixture,spec:checked.spec,spec_hash:checked.spec_hash,context_key:hex('context'),
    participants:list.map((id,index)=>({participant_id:id,source_hash:hex('source-'+id),origin,fixture,context_key:hex('context'),freeze:{subject:{index},disclosure:{prior_searches:[],gates:{G5:'PASS'}}}})),...patch};
}
const create=async(target,owner,options)=>{const input=inputFor(owner,options);const result=await createComparison(target,input);assert.equal(result.ok,true,JSON.stringify(result));return {result,input};};

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const suffix=randomUUID().replaceAll('-','');
  templateName='robot_s2cc_tpl_'+suffix;databaseName='robot_s2cc_main_'+suffix;roleName='robot_s2cc_rt_'+suffix.slice(0,14);
  await admin.query('CREATE ROLE '+roleName+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await admin.query('CREATE DATABASE '+templateName);
  const builder=new PostgresDatabase({connectionString:urlOf(templateName),max:2});
  try{
    await builder.migrate();
    for(const name of ['pine-bridge-schema.sql','quant-research-schema.sql'])await install(builder,name);
    await migrateQuantExposureRegister(builder);
    await migrateQuantComparison(builder);
  }finally{await builder.close();}
  await admin.query('CREATE DATABASE '+databaseName+' TEMPLATE '+templateName);
  connectionString=urlOf(databaseName);
  db=track(new PostgresDatabase({connectionString,max:6}));
  store=new Store(db);
  await db.query(await grantScript(roleName));
  rt=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:6}));rt2=track(new PostgresDatabase({connectionString:urlOf(databaseName,roleName),max:6}));
});
after(async()=>{
  for(const pool of pools)await pool.close().catch(()=>{});
  if(admin){
    for(const name of [...databases,databaseName,templateName])await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)').catch(()=>{});
    await admin.query('DROP ROLE IF EXISTS '+roleName).catch(()=>{});
    await admin.close();
  }
});

/* ---- 1. create and read ---- */

test('create: two, three and four participants store the spec, the participants, the SPEC_FROZEN event and one register event each, in one SERIALIZABLE transaction',async()=>{
  const owner=await newOwner('s2cc-happy');
  for(const count of [2,3,4]){
    const researchBefore=[await rowDigest(db,'public.users'),await rowDigest(db,'public.quant_jobs'),await rowDigest(db,'public.quant_job_steps')];
    const clockBefore=await dbClock(db);
    const {result,input}=await create(rt,owner,{count,fixture:count!==3});
    const clockAfter=await dbClock(db);
    assert.deepEqual([result.existing,result.attempts,result.participants.length],[false,1,count]);
    assert.ok(result.frozen_at_ms>=clockBefore&&result.frozen_at_ms<=clockAfter,'the freeze time is the database clock: '+[clockBefore,result.frozen_at_ms,clockAfter].join());
    const spec=(await db.query(`SELECT * FROM ${SPECS} WHERE comparison_id=$1`,[result.comparison_id])).rows[0];
    assert.deepEqual([spec.owner_id,spec.mode,spec.fixture,spec.broker,spec.symbol,spec.timeframe,Number(spec.start_ms),Number(spec.end_ms),spec.participant_count,spec.context_key,spec.spec_hash,spec.parent_comparison_id,spec.request_key_hash],
      [owner,'STANDARDIZED',count!==3,'binance-global','BTCUSDT','1',input.spec.period.start_ms,input.spec.period.end_ms,count,hex('context'),input.spec_hash,null,null]);
    assert.equal(spec.spec_canonical,canonical(input.spec));assert.equal(spec.spec_body_hash,hash(canonical(input.spec)));assert.equal(Number(spec.frozen_at_ms),result.frozen_at_ms);
    const participants=(await db.query(`SELECT * FROM ${PARTICIPANTS} WHERE comparison_id=$1 ORDER BY "position"`,[result.comparison_id])).rows;
    assert.deepEqual(participants.map(row=>[row.participant_id,row.position,row.source_hash,row.origin,row.fixture]),
      input.participants.map((item,index)=>[item.participant_id,index+1,item.source_hash,item.origin,item.fixture]));
    for(const row of participants){
      const freeze=JSON.parse(row.freeze_canonical);
      assert.equal(row.freeze_hash,hash(row.freeze_canonical));assert.equal(row.freeze_canonical,canonical(freeze));
      assert.deepEqual([freeze.participant_id,freeze.source_hash,freeze.prior_exposed_by,freeze.disclosure.gates],[row.participant_id,row.source_hash,[],{G5:'PASS'}]);
    }
    const events=(await db.query(`SELECT seq,status,reason_code,at_ms FROM ${EVENTS} WHERE comparison_id=$1`,[result.comparison_id])).rows;
    assert.deepEqual(events.map(row=>[row.seq,row.status,row.reason_code]),[[1,'SPEC_FROZEN',null]]);
    assert.ok(Number(events[0].at_ms)>result.frozen_at_ms,'the first event is strictly later than the freeze');
    const register=(await db.query(`SELECT * FROM ${REGISTER} WHERE comparison_id=$1 ORDER BY participant_run_id COLLATE "C"`,[result.comparison_id])).rows;
    assert.deepEqual(register.map(row=>[row.kind,row.owner_id,row.broker,row.symbol,row.timeframe,Number(row.start_ms),Number(row.end_ms),row.participant_run_id,row.source_hash,row.selection_id]),
      input.participants.map(item=>['QR3_COMPARISON',owner,'binance-global','BTCUSDT','1',input.spec.period.start_ms,input.spec.period.end_ms,item.participant_id,item.source_hash,null]).sort((a,b)=>a[7]<b[7]?-1:1));
    assert.equal(new Set(register.map(row=>Number(row.at_ms))).size,1,'one application clock value for every event of the create');
    assert.equal(Number(register[0].at_ms),result.exposure_at_ms);
    // the read returns what was stored
    const view=await readComparison(rt,{owner_id:owner,comparison_id:result.comparison_id});
    assert.equal(view.ok,true,JSON.stringify(view));
    assert.deepEqual([view.comparison.spec_hash,view.comparison.spec,view.comparison.window,view.comparison.fixture,view.comparison.participant_count,view.status.status],
      [input.spec_hash,input.spec,{start_ms:input.spec.period.start_ms,end_ms:input.spec.period.end_ms},count!==3,count,'SPEC_FROZEN']);
    assert.deepEqual(view.participants.map(item=>item.participant_id),input.participants.map(item=>item.participant_id));
    // research and account rows are byte-identical after a create (13.2 item 8)
    assert.deepEqual([await rowDigest(db,'public.users'),await rowDigest(db,'public.quant_jobs'),await rowDigest(db,'public.quant_job_steps')],researchBefore);
  }
});

test('create: the first statement of the SERIALIZABLE transaction is the register lock; nothing runs before it and the spec rows follow it',async()=>{
  const owner=await newOwner('s2cc-order');
  const watched=spy(rt);
  const made=await createComparison(watched.db,inputFor(owner,{count:3}));
  assert.equal(made.ok,true,JSON.stringify(made));
  assert.match(watched.log[0],/^LOCK TABLE public\.quant_exposure_register IN SHARE ROW EXCLUSIVE MODE$/,watched.log[0]);
  const order=watched.log.map(sql=>sql.replace(/\s+/g,' ').slice(0,60));
  const index=pattern=>order.findIndex(sql=>pattern.test(sql));
  assert.ok(index(/INSERT INTO public.quant_exposure_register/)<index(/INSERT INTO public.quant_comparison_specs/));
  assert.ok(index(/INSERT INTO public.quant_comparison_specs/)<index(/INSERT INTO public.quant_comparison_participants/));
  assert.ok(index(/INSERT INTO public.quant_comparison_participants/)<index(/INSERT INTO public.quant_comparison_status_events/));
  const writes=order.filter(sql=>/^(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)/.test(sql));
  assert.equal(writes.length,1+3+1+3,'register events, spec, participants and event; nothing else is written');
  assert.ok(writes.every(sql=>/^INSERT INTO public\.(quant_exposure_register|quant_comparison_specs|quant_comparison_participants|quant_comparison_status_events)\(/.test(sql)),'every write targets one of the four tables, so no research row is touched: '+writes.join(' | '));
  // the transaction level was SERIALIZABLE (a lower level would have met QR003 at the first register insert)
  assert.equal(watched.log.some(sql=>/transaction_isolation/.test(sql)),true);
});

test('create: prior exposure is recorded from the locked register read; a window that only touches, another owner and another comparison of the same owner behave as the contract says',async()=>{
  const owner=await newOwner('s2cc-prior'),other=await newOwner('s2cc-prior-other');
  const W=nextWindow();
  const first=await create(rt,owner,{window:W});
  assert.deepEqual(first.result.participants.map(item=>item.prior_exposed_by),[[],[]],'an empty register is valid');
  // a QR-4 selection exposure of the same owner and market overlapping the window (written by the register writer)
  const selection=await rt.transaction(()=>appendExposures(rt,{owner_id:owner,...MARKET,events:[{kind:'QR4_SELECTION',window:{start_ms:W.start_ms+60*MINUTE,end_ms:W.end_ms+60*MINUTE},selection_id:'sel-prior-'+randomUUID().slice(0,8)}]}),serializable);
  assert.equal(selection.ok,true);
  const second=await create(rt,owner,{window:W});
  const prior=second.result.participants[0].prior_exposed_by;
  assert.deepEqual(prior.map(item=>[item.kind,item.id]).sort((a,b)=>a[1]<b[1]?-1:1),
    [['QR3_COMPARISON',first.result.comparison_id],['QR4_SELECTION',selection.rows[0].selection_id]].sort((a,b)=>a[1]<b[1]?-1:1));
  assert.ok(prior.every(item=>item.window.start_ms<W.end_ms+60*MINUTE&&item.at_ms>0));
  assert.deepEqual(second.result.participants[1].prior_exposed_by,prior,'the same list for every participant: the scope is owner, market and window');
  const stored=(await db.query(`SELECT freeze_canonical FROM ${PARTICIPANTS} WHERE comparison_id=$1 ORDER BY "position"`,[second.result.comparison_id])).rows.map(row=>JSON.parse(row.freeze_canonical).prior_exposed_by);
  assert.deepEqual(stored,[prior,prior],'the list is part of the stored, hashed participant record');
  // a window past every earlier window has no prior exposure
  const touching=await create(rt,owner,{window:{start_ms:W.end_ms+120*MINUTE,end_ms:W.end_ms+180*MINUTE}});
  assert.deepEqual(touching.result.participants[0].prior_exposed_by,[],'a window past every earlier window has no prior exposure');
  const edge=await create(rt,owner,{window:{start_ms:W.start_ms-1440*MINUTE,end_ms:W.start_ms}});
  assert.deepEqual(edge.result.participants[0].prior_exposed_by,[],'a window that ends where the first begins only touches it');
  // another owner is unaffected by this owner's exposures
  const foreign=await create(rt,other,{window:W});
  assert.deepEqual(foreign.result.participants[0].prior_exposed_by,[]);
  // only the register rows of the SAME comparison are excluded: a selection whose id text equals the new comparison id stays listed
  const sharedId='same-id-'+randomUUID().slice(0,8);
  const SW=nextWindow();
  const sharedSelection=await rt.transaction(()=>appendExposures(rt,{owner_id:owner,...MARKET,events:[{kind:'QR4_SELECTION',window:SW,selection_id:sharedId}]}),serializable);
  assert.equal(sharedSelection.ok,true);
  const sameId=await create(rt,owner,{window:SW,patch:{comparison_id:sharedId}});
  assert.deepEqual(sameId.result.participants[0].prior_exposed_by.map(item=>[item.kind,item.id]),[['QR4_SELECTION',sharedId]]);
  // the exposure is permanent: a cancel keeps it, so a later create still sees it
  await rt.transaction(()=>rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,2,'CANCELLED')`,[first.result.comparison_id]),serializable);
  const third=await create(rt,owner,{window:W});
  assert.ok(third.result.participants[0].prior_exposed_by.some(item=>item.id===first.result.comparison_id));
});

test('create: two concurrent creates over the same participants serialize on the register lock and give two comparisons; the second one lists the first',async()=>{
  const owner=await newOwner('s2cc-race');
  const W=nextWindow(),ids=['race-a','race-b'];
  const insideA=gate(),releaseA=gate();
  const watched=spy(rt,{before:async sql=>{if(/INSERT INTO public.quant_comparison_status_events/.test(sql)){insideA.open();await releaseA.promise;}}});
  const A=createComparison(watched.db,inputFor(owner,{ids,window:W}));
  await insideA.promise;
  const B=createComparison(rt2,inputFor(owner,{ids,window:W}));
  // B waits on the register lock that A holds until commit
  await until(async()=>(await db.query(`SELECT count(*)::int n FROM pg_locks WHERE NOT granted AND locktype='relation' AND relation='${REGISTER}'::regclass`)).rows[0].n>=1,'create B to wait for the register lock');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${REGISTER} WHERE owner_id=$1`,[owner])).rows[0].n,0,'nothing of A is visible before its commit');
  releaseA.open();
  const [a,b]=[await A,await B];
  assert.deepEqual([a.ok,b.ok,a.attempts,b.attempts],[true,true,1,1],'B waited for the lock; it did not fail with 40001');
  assert.notEqual(a.comparison_id,b.comparison_id);
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${REGISTER} WHERE owner_id=$1`,[owner])).rows[0].n,4,'2 comparisons x 2 participants = 4 register events');
  assert.deepEqual(a.participants.map(item=>item.prior_exposed_by),[[],[]]);
  assert.deepEqual(b.participants[0].prior_exposed_by.map(item=>item.id),[a.comparison_id],'the second create saw the first one committed (13.2 item 7)');
  // two different owners on the same window both commit and see nothing of each other
  const X=await newOwner('s2cc-x'),Y=await newOwner('s2cc-y');
  const both=await Promise.all([createComparison(rt,inputFor(X,{ids:['x-a','x-b'],window:W})),createComparison(rt2,inputFor(Y,{ids:['x-a','x-b'],window:W}))]);
  assert.deepEqual(both.map(item=>item.ok),[true,true]);assert.deepEqual(both.map(item=>item.participants[0].prior_exposed_by),[[],[]]);
});

/* ---- 2. atomicity: the deferred commit check ---- */

const specInsert=`INSERT INTO ${SPECS}(comparison_id,owner_id,parent_comparison_id,mode,fixture,broker,symbol,timeframe,start_ms,end_ms,participant_count,context_key,spec_hash,spec_canonical,
  spec_body_hash,request_key_hash) VALUES($1,$2,NULL,'STANDARDIZED',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL)`;
const participantInsert=`INSERT INTO ${PARTICIPANTS}(comparison_id,participant_id,"position",source_hash,origin,fixture,context_key,freeze_canonical,freeze_hash) VALUES($1,$2,$3,$4,'FIXTURE',true,$5,$6,$7)`;
/**
 * The create transaction written out in SQL with a knob for every part the commit check judges. Defaults are the correct create.
 * ids: participants of the spec and of the participant rows; registerBatches: [{events:[{id,source,window,owner}], at, owner, market}] (one appendExposures call each);
 * statuses: the event rows after the spec; immediate: SET CONSTRAINTS ALL IMMEDIATE after the spec insert; participantIds: rows stored as participants;
 * earlier: ids whose register events are committed by a transaction of their own BEFORE the create transaction; specPatch: fields replaced in the spec body
 * (the stored text then is not the normal form, which only a raw writer can do); savepoint: the spec row is written inside a released SAVEPOINT;
 * lateImmediate: SET CONSTRAINTS ALL IMMEDIATE after every create row; lateStatuses: status rows after that.
 */
async function rawCreate(target,owner,{ids=['raw-a','raw-b'],participantIds=ids,registerBatches=null,statuses=[[1,'SPEC_FROZEN']],immediate=false,isolation='SERIALIZABLE',window=nextWindow(),specIds=ids,
  earlier=null,specPatch=null,savepoint=false,lateImmediate=false,lateStatuses=[]}={}){
  const comparisonId='raw-'+randomUUID().slice(0,12);
  const checked=specFor(specIds,window),text=canonical(specPatch?{...checked.spec,...specPatch}:checked.spec);
  const batches=registerBatches??[{events:ids.map(id=>({id}))}];
  const register=async(batch,index)=>{
    const written=await appendExposures(target,{owner_id:batch.owner??owner,...(batch.market??MARKET),now:()=>batch.at??1700000000000+index,events:batch.events.map(item=>({kind:'QR3_COMPARISON',
      window:item.window??window,comparison_id:comparisonId,participant_run_id:item.id,source_hash:item.source??hex('source-'+item.id)}))});
    assert.equal(written.ok,true);
  };
  if(earlier)await target.transaction(()=>register({events:earlier.map(id=>({id}))},0),{isolation});
  await target.transaction(async()=>{
    for(const [index,batch] of batches.entries())await register(batch,index);
    if(savepoint)await target.query('SAVEPOINT spec_row');
    await target.query(specInsert,[comparisonId,owner,true,MARKET.broker,MARKET.symbol,MARKET.timeframe,window.start_ms,window.end_ms,specIds.length,hex('context'),specPatch?hex('patched'):checked.spec_hash,text,hash(text)]);
    if(savepoint)await target.query('RELEASE SAVEPOINT spec_row');
    if(immediate)await target.query('SET CONSTRAINTS ALL IMMEDIATE');
    for(const [index,id] of participantIds.entries()){
      const freeze=canonical({participant_id:id,source_hash:hex('source-'+id),prior_exposed_by:[]});
      await target.query(participantInsert,[comparisonId,id,index+1,hex('source-'+id),hex('context'),freeze,hash(freeze)]);
    }
    for(const [seq,status] of statuses)await target.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,$2,$3)`,[comparisonId,seq,status]);
    if(lateImmediate)await target.query('SET CONSTRAINTS ALL IMMEDIATE');
    for(const [seq,status] of lateStatuses)await target.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,$2,$3)`,[comparisonId,seq,status]);
  },{isolation});
  return comparisonId;
}

test('atomicity: the commit check refuses every create that is missing a part or carries a wrong one, and a refused create leaves nothing behind, register included',async()=>{
  const owner=await newOwner('s2cc-atomic'),other=await newOwner('s2cc-atomic-other');
  // control: the written-out create with every default commits and the read sees it
  const good=await rawCreate(rt,owner);
  assert.equal((await readComparison(rt,{owner_id:owner,comparison_id:good})).ok,true);
  const W=nextWindow();
  const shifted={start_ms:W.start_ms,end_ms:W.end_ms-MINUTE};
  const cases=[
    ['no participants',{participantIds:[],registerBatches:[{events:[{id:'raw-a'},{id:'raw-b'}]}]}],
    ['one of two participants',{participantIds:['raw-a']}],
    ['participants other than the spec declares',{ids:['raw-a','raw-c'],specIds:['raw-a','raw-b']}],
    ['no status event',{statuses:[]}],
    ['an extra status event',{statuses:[[1,'SPEC_FROZEN'],[2,'EVALUATING']]},TRANSITION_GUARD],
    ['a later status event after SET CONSTRAINTS ALL IMMEDIATE on a correct create',{lateImmediate:true,lateStatuses:[[2,'EVALUATING']]},TRANSITION_GUARD],
    ['a later status event when the spec row was written inside a released savepoint',{savepoint:true,lateImmediate:true,lateStatuses:[[2,'CANCELLED']]},TRANSITION_GUARD],
    ['a spec that lists participants as numbers',{ids:['1','2'],specPatch:{participants:[1,2]}}],
    ['no register events',{registerBatches:[]}],
    ['one register event of two',{registerBatches:[{events:[{id:'raw-a'}]}]}],
    ['an extra register event',{registerBatches:[{events:[{id:'raw-a'},{id:'raw-b'},{id:'raw-c'}]}]}],
    ['register events of other participants',{registerBatches:[{events:[{id:'raw-a'},{id:'raw-x'}]}]}],
    ['a register event with another source hash',{registerBatches:[{events:[{id:'raw-a'},{id:'raw-b',source:hex('other')}]}]}],
    ['a register event with another window',{registerBatches:[{events:[{id:'raw-a'},{id:'raw-b',window:shifted}]}]}],
    ['register events of another owner',{registerBatches:[{owner:other,events:[{id:'raw-a'},{id:'raw-b'}]}]}],
    ['register events of another market',{registerBatches:[{market:{...MARKET,broker:'binance-us'},events:[{id:'raw-a'},{id:'raw-b'}]}]}],
    ['register events of another symbol',{registerBatches:[{market:{...MARKET,symbol:'ETHUSDT'},events:[{id:'raw-a'},{id:'raw-b'}]}]}],
    ['register events of another timeframe',{registerBatches:[{market:{...MARKET,timeframe:'5'},events:[{id:'raw-a'},{id:'raw-b'}]}]}],
    ['register events with two clock values',{registerBatches:[{events:[{id:'raw-a'}],at:1700000000001},{events:[{id:'raw-b'}],at:1700000000002}]}],
    ['SET CONSTRAINTS ALL IMMEDIATE after the spec',{immediate:true}]];
  for(const [label,options,guard=COMPLETE_GUARD] of cases){
    const before=await allRows(db);
    await refusedBy(rawCreate(rt,owner,{...options,window:options.window??nextWindow()}),QR004,guard).catch(error=>{throw Error(label+': '+error.message);});
    assert.deepEqual(await allRows(db),before,label+': nothing was stored, the register events were rolled back with the rest');
  }
  // register events committed by an EARLIER transaction never satisfy the commit check of a spec-only create (RC-C32, RC-C40); the earlier register rows
  // are evidence of their own and stay, everything of the refused create is gone
  const earlierBefore=await Promise.all([SPECS,PARTICIPANTS,EVENTS].map(table=>rowDigest(db,table)));
  const registerRowsBefore=(await db.query(`SELECT count(*)::int n FROM ${REGISTER}`)).rows[0].n;
  await refusedBy(rawCreate(rt,owner,{registerBatches:[],earlier:['raw-a','raw-b']}),QR004,COMPLETE_GUARD);
  assert.deepEqual(await Promise.all([SPECS,PARTICIPANTS,EVENTS].map(table=>rowDigest(db,table))),earlierBefore,'the spec-only create stored nothing');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${REGISTER}`)).rows[0].n,registerRowsBefore+2,'only the two register rows of the earlier transaction stay');
  // a third participant row of a two-participant spec is refused by the participant guard itself, before the commit check
  await refusedBy(rawCreate(rt,owner,{participantIds:['raw-a','raw-b','raw-c']}),QR004,'quant_comparison_participant_position');
  assert.deepEqual(await allRows(db),await allRows(db));
  // below SERIALIZABLE the register guard refuses the first event (QR003), and the comparison tables refuse their own rows
  const before=await allRows(db);
  await assert.rejects(rawCreate(rt,owner,{isolation:'READ COMMITTED'}),error=>error.code===QR003);
  await assert.rejects(rawCreate(rt,owner,{isolation:'REPEATABLE READ'}),error=>error.code===SERIALIZABLE_SQLSTATE);
  assert.deepEqual(await allRows(db),before);
  // 'no register' variants also under READ COMMITTED: the spec insert itself is refused
  await assert.rejects(rawCreate(rt,owner,{registerBatches:[],isolation:'READ COMMITTED'}),error=>error.code===QR003);
  assert.deepEqual(await allRows(db),before);
  // the commit check also covers a comparison written beside a correct one: only the broken create is refused
  await rawCreate(rt,owner);
  await refusedBy(rawCreate(rt,owner,{participantIds:['raw-a']}),QR004,COMPLETE_GUARD);
});

/* ---- 3. refusals, mapping, retries ---- */

test('create refusals that need no database are answered before any statement runs',async()=>{
  const owner='refusal-owner';
  const base=()=>inputFor(owner,{window:{start_ms:T0,end_ms:T0+60*MINUTE}});
  const withSpec=(patch,fields={})=>{const checked=specFor(['a1','a2'],{start_ms:T0,end_ms:T0+60*MINUTE},patch);return {...base(),spec:checked.spec,spec_hash:checked.spec_hash,
    participants:['a1','a2'].map((id,index)=>({participant_id:id,source_hash:hex('s'+id),origin:'FIXTURE',fixture:true,context_key:hex('c'),freeze:{index}})),...fields};};
  const misaligned=validateSpec({...specFor(['a1','a2'],{start_ms:T0,end_ms:T0+60*MINUTE}).spec,period:{start_ms:T0+1,end_ms:T0+60*MINUTE}});
  const cases=[
    ['no owner',{...base(),owner_id:''},CODES.INVALID_FIELDS],
    ['bad comparison id',{...base(),comparison_id:'-bad'},CODES.INVALID_FIELDS],
    ['self parent',{...base(),comparison_id:'same',parent_comparison_id:'same'},CODES.INVALID_FIELDS],
    ['bad parent id',{...base(),parent_comparison_id:'bad id'},CODES.INVALID_FIELDS],
    ['fixture flag not boolean',{...base(),fixture:'yes'},CODES.INVALID_FIELDS],
    ['other symbol',{...base(),market:{...MARKET,symbol:'ETHUSDT'}},CODES.QR3_MARKET_UNSUPPORTED],
    ['other broker',{...base(),market:{...MARKET,broker:'binance-us'}},CODES.QR3_MARKET_UNSUPPORTED],
    ['other timeframe',{...base(),market:{...MARKET,timeframe:'5'}},CODES.QR3_TIMEFRAME_UNSUPPORTED],
    ['participants not an array',{...base(),participants:'ab'},CODES.INVALID_FIELDS],
    ['one participant',{...base(),participants:base().participants.slice(0,1)},CODES.QR3_PARTICIPANT_COUNT],
    ['five participants',{...base(),participants:Array.from({length:5},(_,index)=>({...base().participants[0],participant_id:'p'+index}))},CODES.QR3_PARTICIPANT_COUNT],
    ['invalid participant id',{...base(),participants:base().participants.map((item,index)=>index?item:{...item,participant_id:'bad id'})},CODES.INVALID_RUN_ID],
    ['duplicate participant id',{...base(),participants:base().participants.map(item=>({...item,participant_id:'dup'}))},CODES.DUPLICATE_RUN_ID],
    ['spec missing',{...base(),spec:null},CODES.QR3_SPEC_INCOMPLETE],
    ['ACTUAL_BOT spec',{...base(),spec:{mode:'ACTUAL_BOT',participants:['a1','a2'],period:{start_ms:T0,end_ms:T0+60*MINUTE}}},STORE_CODES.ACTUAL_BOT_UNAVAILABLE],
    ['unknown mode',{...base(),spec:{...base().spec,mode:'OTHER'}},CODES.QR3_MODE_REQUIRED],
    ['looser risk filter',{...base(),spec:{...base().spec,risk_filter:{max_drawdown_percent:'50'}}},CODES.QR3_SPEC_INCOMPLETE],
    ['spec not in normal form (extra field)',{...base(),spec:{...base().spec,note:'x'}},CODES.QR3_SPEC_INCOMPLETE],
    ['spec hash of another spec',{...base(),spec_hash:hex('other')},CODES.QR3_SPEC_IMMUTABLE],
    ['spec hash missing',{...base(),spec_hash:undefined},CODES.QR3_SPEC_IMMUTABLE],
    ['misaligned period',{...withSpec({}),spec:misaligned.spec,spec_hash:misaligned.spec_hash},CODES.QR3_PERIOD_INVALID],
    ['context key not hex',{...base(),context_key:'abc'},CODES.INVALID_FIELDS],
    ['spec participants differ from the given ones',{...base(),participants:base().participants.map((item,index)=>index?item:{...item,participant_id:'other-run'})},CODES.INVALID_FIELDS],
    ['fixture participant in a non-fixture comparison',{...withSpec({},{fixture:false})},CODES.QR3_FIXTURE_PARTICIPANT],
    ['origin and fixture disagree',{...base(),participants:base().participants.map(item=>({...item,origin:'LIBRARY_RUN'}))},CODES.INVALID_FIELDS],
    ['unknown origin',{...base(),participants:base().participants.map(item=>({...item,origin:'OTHER'}))},CODES.INVALID_FIELDS],
    ['source hash not hex',{...base(),participants:base().participants.map(item=>({...item,source_hash:'abc'}))},CODES.INVALID_FIELDS],
    ['freeze record missing',{...base(),participants:base().participants.map(item=>({...item,freeze:null}))},CODES.INVALID_FIELDS],
    ['freeze record carrying prior_exposed_by',{...base(),participants:base().participants.map(item=>({...item,freeze:{prior_exposed_by:[]}}))},CODES.INVALID_FIELDS],
    ['freeze record over 256 KiB',{...base(),participants:base().participants.map(item=>({...item,freeze:{pad:'x'.repeat(270000)}}))},CODES.INVALID_FIELDS],
    ['positions repeated',{...base(),participants:base().participants.map(item=>({...item,position:1}))},CODES.INVALID_FIELDS],
    ['position out of range',{...base(),participants:base().participants.map((item,index)=>({...item,position:index+2}))},CODES.INVALID_FIELDS],
    ['request key empty',{...base(),request_key:''},CODES.INVALID_FIELDS],
    ['request key too long',{...base(),request_key:'k'.repeat(201)},CODES.INVALID_FIELDS]];
  for(const [label,input,code] of cases){
    const answer=await createComparison(untouchable(),input);
    assert.deepEqual([answer.ok,answer.code],[false,code],label+': '+JSON.stringify(answer));
  }
  // the spec hash check uses the recomputed hash: the right hash with the right spec passes the pure checks (it then reaches the database)
  assert.equal(specHashOf(base().spec),base().spec_hash);
  await assert.rejects(createComparison(untouchable(),base()),/transaction on a refused request/);
  // a handle that is already inside a transaction is a programming error, not a refusal
  await assert.rejects(rt.transaction(()=>createComparison(rt,base())),/requires its own transaction/);
  await assert.rejects(createComparison(null,base()),/requires its own transaction/);
});

test('create: database refusals map to request refusals and leave nothing behind',async()=>{
  const owner=await newOwner('s2cc-map'),other=await newOwner('s2cc-map-other');
  const before=await allRows(db);
  // a participant row missing at commit: the commit check refuses, mapped to QR3_INTEGRITY_FAILED with the guard name
  const skipped=spy(rt,{answer:sql=>/INSERT INTO public.quant_comparison_participants/.test(sql)?{rows:[],rowCount:1}:undefined});
  const broken=await createComparison(skipped.db,inputFor(owner));
  assert.deepEqual([broken.ok,broken.code,broken.detail],[false,CODES.QR3_INTEGRITY_FAILED,COMPLETE_GUARD]);
  assert.deepEqual(await allRows(db),before);
  // a parent comparison of another owner, an unknown parent, a repeated comparison id and an unknown owner
  const parent=await create(rt,other);
  const foreignParent=await createComparison(rt,{...inputFor(owner),parent_comparison_id:parent.result.comparison_id});
  assert.deepEqual([foreignParent.ok,foreignParent.code,foreignParent.detail],[false,CODES.INVALID_FIELDS,'PARENT_COMPARISON']);
  const unknownParent=await createComparison(rt,{...inputFor(owner),parent_comparison_id:'no-such-parent'});
  assert.deepEqual([unknownParent.ok,unknownParent.code,unknownParent.detail],[false,CODES.INVALID_FIELDS,'PARENT_COMPARISON']);
  const sameOwnerParent=await create(rt,other,{patch:{parent_comparison_id:parent.result.comparison_id}});
  assert.equal((await readComparison(rt,{owner_id:other,comparison_id:sameOwnerParent.result.comparison_id})).comparison.parent_comparison_id,parent.result.comparison_id);
  const repeated=await createComparison(rt,{...inputFor(other),comparison_id:parent.result.comparison_id});
  assert.deepEqual([repeated.ok,repeated.code,repeated.detail],[false,CODES.INVALID_FIELDS,'COMPARISON_ID_EXISTS']);
  const unknownOwner=await createComparison(rt,inputFor('no-such-owner'));
  assert.deepEqual([unknownOwner.ok,unknownOwner.code,unknownOwner.detail],[false,CODES.INVALID_FIELDS,'quant_exposure_register_owner_id_fkey']);
  // the earlier comparison is intact and the refusals added no row
  const after=await allRows(db);
  assert.equal(after[0].n,before[0].n+2,'only the parent and its child were stored');
  assert.equal((await readComparison(rt,{owner_id:other,comparison_id:parent.result.comparison_id})).ok,true);
});

test('create: a 40001 is retried from the first statement up to three times with every check rerun; the register events of a failed attempt are rolled back',async()=>{
  const owner=await newOwner('s2cc-retry');
  const serializationFailure=()=>Object.assign(Error('could not serialize access'),{code:SERIALIZATION_FAILURE});
  let failures=2;
  const flaky=spy(rt,{before:async sql=>{if(/INSERT INTO public.quant_comparison_specs/.test(sql)&&failures>0){failures-=1;throw serializationFailure();}}});
  const made=await createComparison(flaky.db,inputFor(owner));
  assert.deepEqual([made.ok,made.attempts],[true,3]);
  assert.equal(flaky.log.filter(sql=>/^LOCK TABLE/.test(sql)).length,3,'each attempt starts with the register lock');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${REGISTER} WHERE comparison_id=$1`,[made.comparison_id])).rows[0].n,2,'one set of register events: the failed attempts rolled back');
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${SPECS} WHERE owner_id=$1`,[owner])).rows[0].n,1);
  // the retries are bounded: MAX_RETRIES + 1 attempts, then the 40001 is thrown for the caller to answer
  assert.equal(MAX_RETRIES,3);
  const before=await allRows(db);
  const hopeless=spy(rt,{before:async sql=>{if(/INSERT INTO public.quant_comparison_specs/.test(sql))throw serializationFailure();}});
  await assert.rejects(createComparison(hopeless.db,inputFor(owner)),error=>error.code===SERIALIZATION_FAILURE);
  assert.equal(hopeless.log.filter(sql=>/^LOCK TABLE/.test(sql)).length,4);
  assert.deepEqual(await allRows(db),before,'nothing was stored');
  // another failure is not retried
  const hard=spy(rt,{before:async sql=>{if(/INSERT INTO public.quant_comparison_specs/.test(sql))throw Object.assign(Error('boom'),{code:'XX000'});}});
  await assert.rejects(createComparison(hard.db,inputFor(owner)),error=>error.code==='XX000');
  assert.equal(hard.log.filter(sql=>/^LOCK TABLE/.test(sql)).length,1);
  assert.deepEqual(await allRows(db),before);
});

test('create: an absent or unreadable register is QR3_EXPOSURE_REGISTER_UNAVAILABLE and stores nothing; absent comparison tables are QR3_SCHEMA_ABSENT and leave no register event',async()=>{
  // register renamed away (the LOCK fails with 42P01)
  const goneName=await clone('regabsent'),gone=await runtimeOn(goneName);
  const goneOwner=await newOwner('s2cc-gone',new Store(gone.owner));
  await gone.owner.query('ALTER TABLE public.quant_exposure_register RENAME TO s2cc_hidden');
  const goneAnswer=await createComparison(gone.runtime,inputFor(goneOwner));
  assert.deepEqual([goneAnswer.ok,goneAnswer.code,goneAnswer.detail],[false,CODES.QR3_EXPOSURE_REGISTER_UNAVAILABLE,'42P01']);
  assert.deepEqual((await gone.owner.query(`SELECT (SELECT count(*)::int FROM ${SPECS}) s,(SELECT count(*)::int FROM ${PARTICIPANTS}) p,(SELECT count(*)::int FROM ${EVENTS}) e`)).rows[0],{s:0,p:0,e:0});
  // marker row missing: the writer throws EXPOSURE_REGISTER_UNAVAILABLE after its lock
  const markerName=await clone('regmarker'),marker=await runtimeOn(markerName);
  const markerOwner=await newOwner('s2cc-marker',new Store(marker.owner));
  await marker.owner.query('DELETE FROM public.quant_exposure_register_schema');
  const markerAnswer=await createComparison(marker.runtime,inputFor(markerOwner));
  assert.deepEqual([markerAnswer.ok,markerAnswer.code,markerAnswer.detail],[false,CODES.QR3_EXPOSURE_REGISTER_UNAVAILABLE,EXPOSURE_CODES.UNAVAILABLE]);
  assert.equal((await marker.owner.query(`SELECT count(*)::int n FROM ${SPECS}`)).rows[0].n,0);
  // a register row that breaks the table rules: ROW_INVALID
  const rowName=await clone('regrow'),invalid=await runtimeOn(rowName);
  const rowOwner=await newOwner('s2cc-row',new Store(invalid.owner));
  await invalid.owner.transaction(async()=>{
    await invalid.owner.query('ALTER TABLE public.quant_exposure_register DROP CONSTRAINT quant_exposure_register_kind_fields_check');
    await invalid.owner.query(`INSERT INTO public.quant_exposure_register(kind,owner_id,broker,symbol,timeframe,start_ms,end_ms,comparison_id,participant_run_id,source_hash,at_ms)
      VALUES('QR3_COMPARISON',$1,'binance-global','BTCUSDT','1',0,60000,'bad','p',NULL,1)`,[rowOwner]);
  },serializable);
  const rowAnswer=await createComparison(invalid.runtime,inputFor(rowOwner));
  assert.deepEqual([rowAnswer.ok,rowAnswer.code,rowAnswer.detail],[false,CODES.QR3_EXPOSURE_REGISTER_UNAVAILABLE,EXPOSURE_CODES.ROW_INVALID]);
  assert.equal((await invalid.owner.query(`SELECT count(*)::int n FROM ${SPECS}`)).rows[0].n,0);
  // comparison tables absent, register present: the lock and the register events happen, then the spec insert fails 42P01 and everything rolls back
  const bareName=await clone('cmpabsent'),bare=await runtimeOn(bareName);
  const bareOwner=await newOwner('s2cc-bare',new Store(bare.owner));
  await bare.owner.query('ALTER TABLE public.quant_comparison_status_events RENAME TO s2cc_hidden_events');
  await bare.owner.query('ALTER TABLE public.quant_comparison_participants RENAME TO s2cc_hidden_participants');
  await bare.owner.query('ALTER TABLE public.quant_comparison_specs RENAME TO s2cc_hidden_specs');
  const bareAnswer=await createComparison(bare.runtime,inputFor(bareOwner));
  assert.deepEqual([bareAnswer.ok,bareAnswer.code],[false,STORE_CODES.SCHEMA_ABSENT]);
  assert.equal((await bare.owner.query(`SELECT count(*)::int n FROM ${REGISTER}`)).rows[0].n,0,'the register events were rolled back with the failed create');
  // an empty register is valid
  const owner=await newOwner('s2cc-empty');
  assert.deepEqual((await readExposures(rt,{owner_id:owner,...MARKET})).rows,[]);
  assert.equal((await createComparison(rt,inputFor(owner))).ok,true);
});

test('request key: a repeat returns the existing comparison and writes nothing; two concurrent creates with one key leave one comparison; another owner may reuse the key',async()=>{
  const owner=await newOwner('s2cc-key'),other=await newOwner('s2cc-key-other');
  const input=inputFor(owner,{patch:{request_key:'key-1'}});
  const first=await createComparison(rt,input);
  assert.deepEqual([first.ok,first.existing],[true,false]);
  const stored=(await db.query(`SELECT request_key_hash FROM ${SPECS} WHERE comparison_id=$1`,[first.comparison_id])).rows[0].request_key_hash;
  assert.equal(stored,requestKeyHash('key-1'));assert.notEqual(stored,'key-1','the key text itself is never stored');
  const before=await allRows(db);
  const repeat=await createComparison(rt,{...input,comparison_id:undefined});
  assert.deepEqual([repeat.ok,repeat.existing,repeat.comparison_id,repeat.same_spec,repeat.frozen_at_ms,repeat.attempts],[true,true,first.comparison_id,true,first.frozen_at_ms,0]);
  assert.deepEqual(await allRows(db),before,'a repeat writes nothing, so the register is not touched');
  const different=await createComparison(rt,{...inputFor(owner,{patch:{request_key:'key-1'}})});
  assert.deepEqual([different.ok,different.existing,different.same_spec,different.comparison_id],[true,true,false,first.comparison_id],'the same key with another spec returns the first comparison and says so');
  assert.deepEqual(await allRows(db),before);
  // another owner with the same key text gets a comparison of their own
  const foreign=await createComparison(rt,inputFor(other,{patch:{request_key:'key-1'}}));
  assert.deepEqual([foreign.ok,foreign.existing],[true,false]);assert.notEqual(foreign.comparison_id,first.comparison_id);
  // concurrent creates with one key: the loser meets the unique key (or 40001) and answers with the winner
  const racing=inputFor(owner,{patch:{request_key:'key-race'}});
  const answers=await Promise.all([createComparison(rt,{...racing,comparison_id:'race-one-'+randomUUID().slice(0,6)}),createComparison(rt2,{...racing,comparison_id:'race-two-'+randomUUID().slice(0,6)})]);
  assert.deepEqual(answers.map(item=>item.ok),[true,true]);
  assert.equal(new Set(answers.map(item=>item.comparison_id)).size,1,'both answers name the one stored comparison');
  assert.equal(answers.filter(item=>item.existing).length,1);
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${SPECS} WHERE owner_id=$1 AND request_key_hash=$2`,[owner,requestKeyHash('key-race')])).rows[0].n,1);
  assert.equal((await db.query(`SELECT count(*)::int n FROM ${REGISTER} WHERE comparison_id=$1`,[answers[0].comparison_id])).rows[0].n,2,'the loser left no register event');
  // the same key AND the same explicit comparison id: the loser meets the winner's register rows first and still answers existing:true
  for(let round=0;round<3;round+=1){
    const same=inputFor(owner,{patch:{request_key:'key-same-id-'+round,comparison_id:'race-same-'+randomUUID().slice(0,8)}});
    const both=await Promise.all([createComparison(rt,same),createComparison(rt2,same)]);
    assert.deepEqual(both.map(item=>item.ok),[true,true],JSON.stringify(both));
    assert.equal(both.filter(item=>item.existing).length,1);assert.equal(both[0].comparison_id,both[1].comparison_id);
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${REGISTER} WHERE comparison_id=$1`,[same.comparison_id])).rows[0].n,2);
  }
  // a repeated comparison id without a request key is still a refusal, not an existing answer
  const plain=await create(rt,owner);
  const again=await createComparison(rt,{...inputFor(owner),comparison_id:plain.result.comparison_id,request_key:'key-other-id'});
  assert.deepEqual([again.ok,again.code,again.detail],[false,CODES.INVALID_FIELDS,'COMPARISON_ID_EXISTS']);
});

/* ---- 4. the owner read ---- */

test('read: owner-scoped READ ONLY; an absent id, a foreign id and a malformed id answer alike; the stored bodies are re-hashed',async()=>{
  const owner=await newOwner('s2cc-read'),other=await newOwner('s2cc-read-other');
  const {result,input}=await create(rt,owner,{count:3});
  const watched=spy(rt);
  const view=await readComparison(watched.db,{owner_id:owner,comparison_id:result.comparison_id});
  assert.equal(view.ok,true);
  assert.equal(watched.log[0],'SET TRANSACTION READ ONLY','the first statement fixes the mode');
  assert.ok(watched.log.slice(1).every(sql=>/^(SELECT|\s*SELECT)/.test(sql)),'a read only selects: '+watched.log.join(' | ').slice(0,300));
  assert.equal(view.comparison.owner_id,owner);assert.equal(view.comparison.has_request_key,false);assert.equal(view.participants.length,3);
  assert.deepEqual(view.events,[{seq:1,status:'SPEC_FROZEN',reason_code:null,at_ms:view.status.at_ms}]);
  assert.deepEqual(view.participants.map(item=>item.position),[1,2,3]);
  assert.equal(JSON.stringify(view).includes(input.participants[0].freeze.disclosure.gates.G5),true);
  // the read itself cannot write: a statement that writes inside it fails 25006
  await assert.rejects(rt.transaction(async()=>{await rt.query('SET TRANSACTION READ ONLY');await rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,2,'CANCELLED')`,[result.comparison_id]);},{isolation:'REPEATABLE READ'}),error=>error.code==='25006');
  // absent, foreign and malformed ids answer with the same object
  const absent=await readComparison(rt,{owner_id:owner,comparison_id:'no-such-comparison'});
  const foreign=await readComparison(rt,{owner_id:other,comparison_id:result.comparison_id});
  const malformed=await readComparison(rt,{owner_id:owner,comparison_id:'bad id; DROP TABLE'});
  const noOwner=await readComparison(rt,{comparison_id:result.comparison_id});
  for(const answer of [absent,foreign,malformed,noOwner])assert.deepEqual(answer,{ok:false,code:'NOT_FOUND',detail:null});
  // inside a caller transaction the read only selects and needs the caller to have made the transaction READ ONLY
  const inside=await rt.transaction(async()=>{await rt.query('SET TRANSACTION READ ONLY');return readComparison(rt,{owner_id:owner,comparison_id:result.comparison_id});},{isolation:'REPEATABLE READ'});
  assert.deepEqual(inside,view);
  await assert.rejects(rt.transaction(()=>readComparison(rt,{owner_id:owner,comparison_id:result.comparison_id}),{isolation:'REPEATABLE READ'}),/needs a READ ONLY transaction/);
  await assert.rejects(rt.transaction(()=>readComparison(rt,{owner_id:owner,comparison_id:result.comparison_id}),serializable),/needs a READ ONLY transaction/);
  // a damaged stored body is QR3_INTEGRITY_FAILED, never a partial view (all changes rolled back)
  const tamper=async(statement,params=[])=>db.transaction(async()=>{
    await db.query('ALTER TABLE public.quant_comparison_status_events DISABLE TRIGGER quant_comparison_status_events_guard');
    await db.query('ALTER TABLE public.quant_comparison_specs DISABLE TRIGGER quant_comparison_specs_no_change');
    await db.query('ALTER TABLE public.quant_comparison_participants DISABLE TRIGGER quant_comparison_participants_no_change');
    await db.query('ALTER TABLE public.quant_comparison_status_events DISABLE TRIGGER quant_comparison_status_events_no_change');
    await db.query('ALTER TABLE public.quant_comparison_specs DISABLE TRIGGER quant_comparison_specs_complete');
    for(const constraint of ['quant_comparison_specs_spec_digest_check','quant_comparison_specs_spec_body_check'])await db.query('ALTER TABLE public.quant_comparison_specs DROP CONSTRAINT '+constraint);
    for(const constraint of ['quant_comparison_participants_freeze_digest_check','quant_comparison_participants_freeze_body_check'])await db.query('ALTER TABLE public.quant_comparison_participants DROP CONSTRAINT '+constraint);
    await db.query(statement,params);
    await db.query('SET TRANSACTION READ ONLY');
    const answer=await readComparison(db,{owner_id:owner,comparison_id:result.comparison_id});
    throw Object.assign(new Error('tampered'),{answer});
  },serializable).catch(error=>{if(error.message==='tampered')return error.answer;throw error;});
  const cid=result.comparison_id;
  const damaged=[
    ['spec body text',`UPDATE ${SPECS} SET spec_canonical=spec_canonical||' ' WHERE comparison_id=$1`,'SPEC_BODY'],
    ['spec hash',`UPDATE ${SPECS} SET spec_hash=$2 WHERE comparison_id=$1`,'SPEC_HASH',[hex('other')]],
    ['participant freeze text',`UPDATE ${PARTICIPANTS} SET freeze_canonical=freeze_canonical||' ' WHERE comparison_id=$1`,'PARTICIPANT_FREEZE'],
    ['a participant row missing',`DELETE FROM ${PARTICIPANTS} WHERE comparison_id=$1 AND "position"=3`,'PARTICIPANTS'],
    ['the first status event removed',`DELETE FROM ${EVENTS} WHERE comparison_id=$1`,'STATUS_EVENTS'],
    ['a status gap',`INSERT INTO ${EVENTS}(comparison_id,seq,status,at_ms) VALUES($1,3,'CANCELLED',5)`,'STATUS_EVENTS']];
  for(const [label,statement,detail,extra=[]] of damaged){
    const answer=await tamper(statement,[cid,...extra]).catch(error=>{throw Error(label+': '+error.message);});
    assert.deepEqual([answer.ok,answer.code,answer.detail],[false,CODES.QR3_INTEGRITY_FAILED,detail],label);
  }
  assert.equal((await readComparison(rt,{owner_id:owner,comparison_id:cid})).ok,true,'every tamper was rolled back');
  assert.equal((await classifyQuantComparison(db)).state,'INSTALLED');
});

test('read: the status timeline ends at the last event and its stamped times strictly increase',async()=>{
  const owner=await newOwner('s2cc-timeline');
  const {result}=await create(rt,owner);
  await rt.transaction(()=>rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status) VALUES($1,2,'EVALUATING')`,[result.comparison_id]),serializable);
  await rt.transaction(()=>rt.query(`INSERT INTO ${EVENTS}(comparison_id,seq,status,reason_code) VALUES($1,3,'FAILED','NO_DATA')`,[result.comparison_id]),serializable);
  const view=await readComparison(rt,{owner_id:owner,comparison_id:result.comparison_id});
  assert.deepEqual(view.events.map(item=>item.status),['SPEC_FROZEN','EVALUATING','FAILED']);
  assert.deepEqual([view.status.seq,view.status.status,view.status.reason_code],[3,'FAILED','NO_DATA']);
  assert.ok(view.events.every((item,index)=>index===0?item.at_ms>view.comparison.frozen_at_ms:item.at_ms>view.events[index-1].at_ms),'the stamped times strictly increase');
  assert.equal(view.participants.length,2);
});
