import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {PineBridgeService,pineBridgeRoutes} from '../src/postgres/pine-bridge.js';
import {DEPLOYMENT_LIST_LIMIT} from '../src/postgres/pine-bridge-deployments.js';

// GET /api/quant/pine-bridge/deployments?bot_id=...: the real route handler and service behind a real socket. Only the
// database is faked: it answers the one list statement the way PostgreSQL would (filter, sort, limit, projection), and
// the test reads the statement and its parameters. The real SQL runs in test/postgres/pine-bridge-deployments.test.mjs.
const LIST='/api/quant/pine-bridge/deployments';
const SECRET='SECRET_SNAPSHOT_TEXT';
const OWNERS={'owner-1':['bot-1','bot-2'],'owner-2':['bot-9']};

function deploymentRow(index,{owner='owner-1',bot='bot-1',state='DRAFT',at=1000+index,id,market}={}){
  return {deployment_id:id??('00000000-0000-4000-8000-'+String(index).padStart(12,'0')),owner_id:owner,bot_id:bot,state,created_at:at,source_version:1+index%3,
    source_name:'Source '+index,snapshot:{market:market??{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},policy:{note:SECRET},membership:[SECRET]},snapshot_hash:SECRET};
}
function fakeBridge({rows=[],status={},bots=OWNERS}={}){
  const queries=[];
  const db={query:async(sql,params)=>{
    queries.push({sql,params});
    assert.match(sql,/FROM pine_deployments d JOIN pine_sources s ON s\.pine_import_id=d\.pine_import_id/,'only the list statement is expected');
    const [owner,bot]=params,limit=Number(/LIMIT (\d+)\s*$/.exec(sql)[1]);
    const picked=rows.filter(row=>row.owner_id===owner&&row.bot_id===bot).sort((a,b)=>b.created_at-a.created_at||(a.deployment_id<b.deployment_id?1:-1)).slice(0,limit);
    // Only the selected columns come back, as from PostgreSQL.
    return {rows:picked.map(row=>({deployment_id:row.deployment_id,state:row.state,created_at:row.created_at,source_version:row.source_version,source_name:row.source_name,
      broker:row.snapshot.market?.broker??null,symbol:row.snapshot.market?.symbol??null,timeframe:row.snapshot.market?.timeframe??null}))};
  }};
  const store={db,ownsBot:async(owner,bot)=>(bots[owner]??[]).includes(bot),userById:async id=>({id,status:status[id]??'ACTIVE'})};
  return {service:new PineBridgeService(store,{getProvider:()=>({provider:'fixture',model:'fixture'})}),queries,db,store};
}
async function withServer(service,run,{enabled=true}={}){
  const json=(res,code,body)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    try{if(!await pineBridgeRoutes(req,res,url,{id:req.headers['x-test-owner']??'owner-1'},service,json,{enabled}))json(res,404,{error:'Not found'});}
    // Same mapping as the catch of src/postgres/server.js for a request error.
    catch(error){json(res,error.status||400,{error:error.message,...(error.code?{code:error.code}:{})});}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const call=async(path,{method='GET',owner}={})=>{
    const response=await fetch(base+path,{method,headers:{...(owner?{'x-test-owner':owner}:{}),...(method==='POST'?{'content-type':'application/json'}:{})},body:method==='POST'?'{}':undefined});
    return {status:response.status,text:await response.text()};
  };
  try{await run(call);}finally{await new Promise(resolve=>server.close(resolve));}
}
const body=answer=>JSON.parse(answer.text);

test('lists the Bot deployments newest first, at most 20, with the documented fields only',async()=>{
  const rows=[];
  for(let i=0;i<25;i++)rows.push(deploymentRow(i,{state:['DRAFT','READY','EXIT_ONLY','REVOKED'][i%4]}));
  // Rows of another Bot and of another owner are newer than all of them; an unscoped query would show them first.
  for(let i=0;i<3;i++)rows.push(deploymentRow(100+i,{bot:'bot-2',at:900000+i}),deploymentRow(200+i,{owner:'owner-2',bot:'bot-9',at:950000+i}));
  // A tie on created_at falls back to the identifier, newest identifier first.
  rows.push(deploymentRow(300,{at:1024,id:'ffffffff-0000-4000-8000-000000000001'}),deploymentRow(301,{at:1024,id:'ffffffff-0000-4000-8000-000000000002'}));
  const {service,queries}=fakeBridge({rows});
  await withServer(service,async call=>{
    const answer=await call(LIST+'?bot_id=bot-1'),data=body(answer);
    assert.equal(answer.status,200,answer.text);
    assert.deepEqual(Object.keys(data).sort(),['bot_id','deployments']);assert.equal(data.bot_id,'bot-1');
    assert.equal(data.deployments.length,DEPLOYMENT_LIST_LIMIT);assert.equal(DEPLOYMENT_LIST_LIMIT,20);
    const times=data.deployments.map(item=>item.created_at);
    assert.deepEqual(times,[...times].sort((a,b)=>b-a),'newest first');
    assert.deepEqual(data.deployments.slice(0,2).map(item=>item.created_at),[1024,1024]);
    assert.deepEqual(data.deployments.slice(0,2).map(item=>item.deployment_id),['ffffffff-0000-4000-8000-000000000002','ffffffff-0000-4000-8000-000000000001']);
    for(const item of data.deployments){
      assert.deepEqual(Object.keys(item).sort(),['created_at','deployment_id','market','source_name','source_version','state']);
      assert.deepEqual(item.market,{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'});
      assert.match(item.deployment_id,/^[a-f0-9-]{36}$/);assert.ok(['DRAFT','READY','EXIT_ONLY','REVOKED'].includes(item.state));
    }
    assert.ok(data.deployments.every(item=>!/^Source (10\d|20\d)$/.test(item.source_name)),'no row of another Bot or owner');
    assert.doesNotMatch(answer.text,/SECRET|snapshot|owner_id|membership|policy|token|secret/i,'no snapshot, hash, owner or secret reaches the response');
    assert.equal(queries.length,1);
  });
});

test('the statement is one read-only, parameterized, owner and Bot scoped SELECT; a hostile Bot id only ever travels as a parameter',async()=>{
  const hostile="x' OR '1'='1";
  const {service,queries}=fakeBridge({rows:[deploymentRow(1)],bots:{'owner-1':['bot-1',hostile]}});
  await withServer(service,async call=>{
    assert.equal((await call(LIST+'?bot_id=bot-1')).status,200);
    assert.equal((await call(LIST+'?bot_id='+encodeURIComponent(hostile))).status,200);
    assert.equal(queries.length,2);
    assert.equal(queries[0].sql,queries[1].sql,'the text of the statement never depends on the request');
    assert.deepEqual(queries.map(query=>query.params),[['owner-1','bot-1'],['owner-1',hostile]]);
    const sql=queries[0].sql;
    assert.match(sql,/^\s*SELECT /);assert.match(sql,/WHERE d\.owner_id=\$1 AND d\.bot_id=\$2 /);assert.match(sql,/ORDER BY d\.created_at DESC,d\.deployment_id DESC LIMIT 20\s*$/);
    assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|DROP|ALTER|FOR UPDATE|FOR SHARE)\b|;/i,'read-only, no row lock');
    // Nothing that holds Pine text, evidence, hashes, job results or tokens is selected.
    assert.doesNotMatch(sql,/s\.source\b|snapshot_hash|analysis|evidence|result|token|secret|request|usage/i);
    assert.deepEqual(sql.match(/\bd\.snapshot->'market'->>'\w+'/g),["d.snapshot->'market'->>'broker'","d.snapshot->'market'->>'symbol'","d.snapshot->'market'->>'timeframe'"]);
  });
});

test('owner scope: a Bot of another owner, an unknown Bot, and a suspended Bot or owner answer 404 before any deployment is read',async()=>{
  const rows=[deploymentRow(1),deploymentRow(2,{owner:'owner-2',bot:'bot-9'})];
  const {service,queries}=fakeBridge({rows,status:{'bot-2':'SUSPENDED','owner-2':'SUSPENDED'}});
  await withServer(service,async call=>{
    for(const [path,owner] of [[LIST+'?bot_id=bot-9','owner-1'],[LIST+'?bot_id=nope','owner-1'],[LIST+'?bot_id=bot-2','owner-1'],[LIST+'?bot_id=bot-9','owner-2'],[LIST+'?bot_id=bot-1','owner-3']]){
      const answer=await call(path,{owner});
      assert.equal(answer.status,404,path+' '+owner);assert.deepEqual(body(answer),{error:'NOT_FOUND',code:'NOT_FOUND'});
    }
    assert.equal(queries.length,0,'authorization comes first: no deployment query was made');
    assert.equal(body(await call(LIST+'?bot_id=bot-1',{owner:'owner-1'})).deployments.length,1,'the same owner still reads the Bot of his own');
    assert.equal(queries.length,1);assert.deepEqual(queries[0].params,['owner-1','bot-1']);
  });
});

test('the query is strict: bot_id exactly once, nothing else; a rejected request reads nothing',async()=>{
  const {service,queries}=fakeBridge({rows:[deploymentRow(1)]});
  await withServer(service,async call=>{
    for(const path of [LIST,LIST+'?bot_id=',LIST+'?bot_id=bot-1&bot_id=bot-2',LIST+'?bot_id=bot-1&limit=500',LIST+'?bot=bot-1',LIST+'?bot_id=bot-1&state=READY',LIST+'?owner_id=owner-2&bot_id=bot-1']){
      const answer=await call(path);
      assert.equal(answer.status,400,path);assert.deepEqual(body(answer),{error:'INVALID_FIELDS',code:'INVALID_FIELDS'},path);
    }
    assert.equal(queries.length,0);
    assert.equal((await call(LIST+'/?bot_id=bot-1')).status,404,'only the exact path lists');
  });
});

test('GET only: no other method on the list path, no write route, and a closed Bridge answers 503 like every Bridge route',async()=>{
  const {service,queries}=fakeBridge({rows:[deploymentRow(1)]});
  await withServer(service,async call=>{
    for(const method of ['POST'])assert.equal((await call(LIST+'?bot_id=bot-1',{method})).status,404,method);
    assert.equal(queries.length,0);
  });
  await withServer(service,async call=>{
    const answer=await call(LIST+'?bot_id=bot-1');
    assert.equal(answer.status,503);assert.equal(body(answer).code,'PINE_BRIDGE_DISABLED');
    assert.equal(queries.length,0);
  },{enabled:false});
});

test('text fields are capped and checked: a long source name and odd market values never reach the screen unbounded',async()=>{
  const row=deploymentRow(1,{market:{broker:'b'.repeat(80),symbol:{nested:'x'},timeframe:12345}});
  row.source_name='n'.repeat(500);
  // A snapshot without a market object is answered with nulls, not an error.
  const bare=deploymentRow(2);delete bare.snapshot.market;
  const {service}=fakeBridge({rows:[row,bare]});
  await withServer(service,async call=>{
    const [first,second]=body(await call(LIST+'?bot_id=bot-1')).deployments.sort((a,b)=>a.source_name.length-b.source_name.length).reverse();
    assert.equal(first.source_name.length,120);
    assert.deepEqual(first.market,{broker:'b'.repeat(32),symbol:null,timeframe:null});
    assert.deepEqual(second.market,{broker:null,symbol:null,timeframe:null});
  });
});
