import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {PineBridgeService} from '../../src/postgres/pine-bridge.js';
import {listDeployments,DEPLOYMENT_LIST_LIMIT} from '../../src/postgres/pine-bridge-deployments.js';
import {config} from '../../src/config.js';
import {hash,canonical} from '../../src/pine-bridge/source.js';
import {hashPassword} from '../../src/security.js';
import {httpClient} from '../helpers.mjs';

// The real list statement of GET /api/quant/pine-bridge/deployments on an isolated PostgreSQL database.
// test/pine-bridge-deployments.test.js covers the route, the service and the statement text without a database.
let admin,db,store,service,databaseName;
const T=Date.UTC(2026,8,1),MARKER=/SECRET_[A-Z]+/;

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  databaseName='robot_bridge_list_test_'+randomUUID().replaceAll('-','');
  await admin.query('CREATE DATABASE '+databaseName);
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+databaseName;
  db=new PostgresDatabase({connectionString:url.toString(),max:12});await db.migrate();
  await db.transaction(async()=>db.query(await fs.readFile(new URL('../../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8')));
  store=new Store(db);service=new PineBridgeService(store,{defaultRisk:config.defaultRisk,getProvider:()=>({provider:'fixture',model:'fixture'})});
});
after(async()=>{await db?.close();if(admin){if(databaseName)await admin.query('DROP DATABASE IF EXISTS '+databaseName+' WITH (FORCE)');await admin.close();}});

async function newOwner(label){
  const password='list-'+randomUUID(),user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:await hashPassword(password)});
  await store.setRisk(user.id,structuredClone(config.defaultRisk));
  return {id:user.id,email:user.email,password};
}
// Rows carry marker strings in every column the list must never return.
async function seedSource(ownerId,botId,name){
  const id=randomUUID();
  await db.query('INSERT INTO pine_sources(pine_import_id,owner_id,bot_id,source_version,source_hash,source_name,source,analysis,created_at) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)',
    [id,ownerId,botId,hash('source-'+id),name,'//@version=6\n// SECRET_SOURCE\nindicator("x")',JSON.stringify({marker:'SECRET_ANALYSIS'}),T]);
  return id;
}
async function seedDeployment(ownerId,botId,importId,{state='DRAFT',at,version=1}={}){
  const id=randomUUID(),snapshot={policy:{marker:'SECRET_POLICY'},membership:[{marker:'SECRET_MEMBERSHIP'}],selection:{signals:{buy:'buy',exit:'sell'}},
    market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1',deployment_id:id,pine_import_id:importId,source_version:version},artifact_hash:'SECRET_ARTIFACT'};
  await db.query('INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id,ownerId,botId,importId,version,JSON.stringify(snapshot),hash(canonical(snapshot)),state,at]);
  return id;
}

test('the list is scoped to the owner and the Bot, newest first, capped at 20, and carries no snapshot data',async()=>{
  const A=await newOwner('list-a'),B=await newOwner('list-b');
  const second=await store.createBot(A.id,'Second bot',structuredClone(config.defaultRisk));
  const mine=await seedSource(A.id,A.id,'My indicator'),other=await seedSource(A.id,second.id,'Second bot indicator'),theirs=await seedSource(B.id,B.id,'B indicator');
  const states=['DRAFT','EXIT_ONLY','REVOKED','DRAFT'];
  for(let i=0;i<24;i++)await seedDeployment(A.id,A.id,mine,{state:states[i%4],at:T+i*1000,version:1+i%2});
  // At most one READY per Bot and source: this is the newest row of all.
  const ready=await seedDeployment(A.id,A.id,mine,{state:'READY',at:T+99000});
  const tieA=await seedDeployment(A.id,A.id,mine,{at:T+50000}),tieB=await seedDeployment(A.id,A.id,mine,{at:T+50000});
  for(let i=0;i<2;i++)await seedDeployment(A.id,second.id,other,{at:T+500000+i});
  for(let i=0;i<3;i++)await seedDeployment(B.id,B.id,theirs,{at:T+900000+i});
  const answer=await listDeployments(service,A.id,A.id);
  assert.equal(answer.bot_id,A.id);assert.equal(answer.deployments.length,DEPLOYMENT_LIST_LIMIT);
  assert.equal(answer.deployments[0].deployment_id,ready);assert.equal(answer.deployments[0].state,'READY');
  const times=answer.deployments.map(item=>item.created_at);assert.deepEqual(times,[...times].sort((a,b)=>b-a),'newest first');
  const tie=answer.deployments.filter(item=>item.created_at===T+50000).map(item=>item.deployment_id);
  assert.deepEqual(tie,[tieA,tieB].sort().reverse(),'a tie falls back to the identifier, newest identifier first');
  for(const item of answer.deployments){
    assert.deepEqual(Object.keys(item).sort(),['created_at','deployment_id','market','source_name','source_version','state']);
    assert.deepEqual(item.market,{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});assert.equal(item.source_name,'My indicator');
  }
  assert.equal(JSON.stringify(answer).match(MARKER),null,'no snapshot, hash, policy, source or analysis text');
  // The second Bot of the same owner sees only its own two rows.
  const sibling=await listDeployments(service,A.id,second.id);
  assert.equal(sibling.deployments.length,2);assert.ok(sibling.deployments.every(item=>item.source_name==='Second bot indicator'));
  // Another owner's Bot, an unknown Bot and a non-string all answer NOT_FOUND.
  for(const bot of [B.id,randomUUID(),undefined,null,{}])await assert.rejects(listDeployments(service,A.id,bot),{code:'NOT_FOUND',status:404});
  assert.equal((await listDeployments(service,B.id,B.id)).deployments.length,3);
  assert.equal((await listDeployments(service,B.id,B.id)).deployments[0].source_name,'B indicator');
});

test('an owner without deployments gets an empty list, and the read writes nothing',async()=>{
  const C=await newOwner('list-c');
  const counts=async()=>(await db.query('SELECT (SELECT count(*) FROM pine_deployments) deployments,(SELECT count(*) FROM audit) audits')).rows[0];
  const before=await counts();
  assert.deepEqual(await listDeployments(service,C.id,C.id),{bot_id:C.id,deployments:[]});
  assert.deepEqual(await counts(),before);
});

test('HTTP: the list needs a session, is owner scoped, strict about its query, GET only and read-only',async t=>{
  const A=await newOwner('http-a'),B=await newOwner('http-b');
  const mine=await seedSource(A.id,A.id,'HTTP indicator'),theirs=await seedSource(B.id,B.id,'Foreign indicator');
  const draft=await seedDeployment(A.id,A.id,mine,{at:T+1000}),foreign=await seedDeployment(B.id,B.id,theirs,{at:T+2000});
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base='http://127.0.0.1:'+port,request=httpClient(base);
  const child=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,DATABASE_URL:db.pool.options.connectionString,HOST:'127.0.0.1',PORT:String(port),
    PUBLIC_ORIGIN:base,SMTP_HOST:'',PINE_BRIDGE_ENABLED:'1',PINE_AI_MODEL:'gpt-4.1-mini',PINE_AI_API_KEY:'not-a-real-key',PINE_AI_INPUT_USD_PER_MILLION:'0.4',PINE_AI_OUTPUT_USD_PER_MILLION:'1.6',PINE_AI_RATE_VERSION:'test-only'}});
  const exited=once(child,'exit');child.stdout.resume();child.stderr.resume();t.after(async()=>{child.kill();await exited;});
  let ready=false;for(let i=0;i<200&&!ready;i++){try{await fetch(base+'/healthz');ready=true;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
  assert.ok(ready,'server did not start');
  const route='/api/quant/pine-bridge/deployments';
  assert.equal((await request(route+'?bot_id='+A.id)).status,401);
  const login=await request('/api/auth/login','POST',{email:A.email,password:A.password});assert.equal(login.status,200);const session=login.session;
  const own=await request(route+'?bot_id='+A.id,'GET',undefined,session);
  assert.equal(own.status,200,JSON.stringify(own.body));
  assert.deepEqual(own.body.deployments.map(item=>item.deployment_id),[draft]);
  assert.equal(own.body.deployments[0].state,'DRAFT');assert.equal(own.body.deployments[0].source_name,'HTTP indicator');
  assert.equal(JSON.stringify(own.body).match(MARKER),null);assert.ok(!JSON.stringify(own.body).includes(foreign));
  assert.equal((await request(route+'?bot_id='+B.id,'GET',undefined,session)).status,404,'a Bot of another owner');
  assert.equal((await request(route,'GET',undefined,session)).body.code,'INVALID_FIELDS');
  assert.equal((await request(route+'?bot_id='+A.id+'&state=READY','GET',undefined,session)).body.code,'INVALID_FIELDS');
  assert.equal((await request(route+'?bot_id='+A.id,'POST',{},session)).status,404,'no write on the list path');
  assert.equal((await db.query('SELECT state FROM pine_deployments WHERE deployment_id=$1',[draft])).rows[0].state,'DRAFT','reading never changes a deployment');
});
