import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Store} from '../src/postgres/store.js';
import {config} from '../src/config.js';
import {createRequestLimits} from '../src/postgres/request-limits.js';
import {createDispatcher,json} from '../src/postgres/request-dispatch.js';
import {accountOverview,overviewRoute,overviewTag,notModified,OVERVIEW_PATH} from '../src/postgres/overview.js';

const DAY=new Date().toISOString().slice(0,10);
// Two accounts. Every statement goes through the real Store and ledger code against this read-only fake.
function fixture({bots=3,positionsPerBot=1,globalKill=false}={}){
  const users=[];
  for(const owner of ['owner-a','owner-b'])for(let i=0;i<bots;i++)users.push({id:i?owner+'-bot'+i:owner,parent_user_id:i?owner:null,bot_slot_index:i+1,label:i?'Bot '+(i+1):'Main',status:'ACTIVE',webhook_hint:'ab12'});
  const positions=new Map(users.map(user=>[user.id,Array.from({length:positionsPerBot},(_,i)=>({id:user.id+'-p'+i,user_id:user.id,account_id:'binance-global:primary',execution_mode:'PAPER',broker:'binance-global',symbol:'BTCUSDT',quantity:'0.01',avg_price:'60000',cost_basis:'600',opened_at:1700000000000}))]));
  const sessions=new Map([['owner-a',{user_id:'owner-a',state:'RUNNING',run_id:'run-1',locked_policy:'{"pauseAfterLossStreak":3}',initial_capital:'1000',started_at:1700000000000,stopped_at:null}]]);
  const policies=new Map([['owner-a-bot1',JSON.stringify({maxOpenPositions:2,killSwitch:true})]]);
  const statements=[];
  const answer=(sql,params)=>{
    if(/FROM users WHERE id=\? OR parent_user_id=\?/.test(sql))return users.filter(user=>user.id===params[0]||user.parent_user_id===params[1]).sort((a,b)=>a.bot_slot_index-b.bot_slot_index);
    if(/FROM system_settings WHERE key=\?/.test(sql))return params[0]==='globalKill'?{value:JSON.stringify(globalKill)}:undefined;
    if(/FROM ledger_daily d/.test(sql))return [{user_id:params[0],account_id:'binance-global:primary',execution_mode:params[1],day:params[2],trades:2,notional:'120.5',realized_r:'-0.5',loss_streak:1}];
    if(/FROM paper_funding WHERE user_id=\? AND broker=\?/.test(sql))return params[1]==='binance-global'?{equity:'1000',cash:'1000'}:{equity:'0',cash:'0'};
    if(/FROM paper_cash_journal/.test(sql))return {amount:params[1]==='binance-global'?'-600':'0'};
    if(/SUM\(cost_basis\)/.test(sql))return {amount:params[1]==='binance-global'?String(600*positionsPerBot):'0'};
    if(/FROM bot_sessions WHERE user_id=\?/.test(sql))return sessions.get(params[0]);
    if(/FROM risk_profiles WHERE user_id=\?/.test(sql))return policies.has(params[0])?{policy:policies.get(params[0])}:undefined;
    if(/FROM ledger_positions WHERE user_id=\? AND quantity>0/.test(sql))return positions.get(params[0])||[];
    throw new Error('unexpected SQL: '+sql);
  };
  let readOnly=false;
  const db={
    // Nested like PostgresDatabase.transaction inside the request transaction: the callback runs on the same client.
    transaction:async fn=>fn(),
    query:async sql=>{statements.push({sql,params:[]});if(sql==='SET TRANSACTION READ ONLY')readOnly=true;else throw new Error('unexpected query: '+sql);return {rows:[]};},
    prepare:sql=>({
    get:async(...params)=>{statements.push({sql,params});return answer(sql,params);},
    all:async(...params)=>{statements.push({sql,params});return answer(sql,params);},
    run:async()=>{throw new Error((readOnly?'read-only transaction: ':'')+'the overview attempted a write: '+sql);}
  })};
  return {store:new Store(db),statements,users,positions};
}

test('overview returns every Bot of the account with the /api/me fields the overview page reads',async()=>{
  const {store}=fixture();
  const body=await accountOverview(store,'owner-a',config.defaultRisk);
  assert.deepEqual(Object.keys(body),['moneyFormat','globalKill','bots','positions']);
  assert.equal(body.moneyFormat,'decimal-string');assert.equal(body.globalKill,false);
  assert.deepEqual(body.bots.map(bot=>bot.id),['owner-a','owner-a-bot1','owner-a-bot2']);
  for(const bot of body.bots){
    assert.deepEqual(Object.keys(bot),['id','parent_user_id','bot_slot_index','label','status','webhook_hint','risk','botSession','paperAccounts','dailyAccounts','daily']);
    assert.equal(bot.risk.paperTrading,true);
    assert.equal(bot.paperAccounts.length,4);
    assert.ok(bot.paperAccounts.every(row=>row.bot_id===bot.id&&row.userId===bot.id));
    assert.ok(bot.dailyAccounts.every(row=>row.bot_id===bot.id&&row.user_id===bot.id&&row.day===DAY&&row.execution_mode==='PAPER'));
    assert.equal(bot.daily.trades,2);
  }
  const [main,second,third]=body.bots;
  assert.deepEqual(main.botSession,{state:'RUNNING',run_id:'run-1',started_at:1700000000000,stopped_at:null},'no locked policy or capital leaks out');
  assert.deepEqual(second.botSession,{state:'SETUP',run_id:null,started_at:null,stopped_at:null});
  assert.deepEqual(second.risk,{...config.defaultRisk,maxOpenPositions:2,killSwitch:true,paperTrading:true},'stored policy over defaults, like /api/me');
  assert.deepEqual(third.risk,{...config.defaultRisk,paperTrading:true});
  const usdt=main.paperAccounts.find(row=>row.broker==='binance-global');
  assert.equal(usdt.currency,'USDT');assert.equal(Number(usdt.cash),400);assert.equal(Number(usdt.bookEquity),1000);assert.equal(Number(usdt.positionCost),600);
  assert.deepEqual(body.positions.map(row=>[row.bot_id,row.bot_label,row.user_id]),[['owner-a','Main','owner-a'],['owner-a-bot1','Bot 2','owner-a-bot1'],['owner-a-bot2','Bot 3','owner-a-bot2']]);
});

test('overview turns the transaction READ ONLY first, reads only the signed-in account and costs 3 + 16 statements per Bot',async()=>{
  const {store,statements}=fixture({bots:3});
  const body=await accountOverview(store,'owner-a',config.defaultRisk);
  const mine=new Set(['owner-a','owner-a-bot1','owner-a-bot2']);
  assert.ok(!JSON.stringify(body).includes('owner-b'),'no row of another account');
  assert.equal(statements[0].sql,'SET TRANSACTION READ ONLY','before the first overview read');
  for(const {sql,params} of statements.slice(1)){
    if(/system_settings/.test(sql))assert.deepEqual(params,['globalKill']);
    else assert.ok(mine.has(params[0]),sql+' addressed '+params[0]);
  }
  assert.equal(statements.length,3+16*3);
  // The page used to send 1 + N + 1 requests per cycle, each with its own limiter row, session touch and transaction.
});

test('the route always covers the signed-in account and ignores bot_id and user_id',async()=>{
  const {store}=fixture();
  const sent=[];
  const res={headers:new Map(),setHeader(name,value){this.headers.set(name,value);}};
  const capture=(r,status,body)=>sent.push({status,body});
  const url=new URL('http://localhost'+OVERVIEW_PATH+'?bot_id=owner-b-bot1&user_id=owner-b');
  assert.equal(await overviewRoute({method:'GET',headers:{}},res,url,{id:'owner-a'},{store,json:capture,defaultRisk:config.defaultRisk}),true);
  assert.equal(sent[0].status,200);
  assert.deepEqual(sent[0].body.bots.map(bot=>bot.id),['owner-a','owner-a-bot1','owner-a-bot2']);
  for(const [method,path] of [['POST',OVERVIEW_PATH],['PUT',OVERVIEW_PATH],['HEAD',OVERVIEW_PATH],['GET',OVERVIEW_PATH+'/x'],['GET','/api/overviews']])
    assert.equal(await overviewRoute({method,headers:{}},res,new URL('http://localhost'+path),{id:'owner-a'},{store,json:capture,defaultRisk:config.defaultRisk}),false,method+' '+path);
});

test('ETag is stable for unchanged data, changes with the data, and If-None-Match uses weak comparison',async()=>{
  const first=fixture(),again=fixture(),moved=fixture({positionsPerBot:2});
  const tag=overviewTag(await accountOverview(first.store,'owner-a',config.defaultRisk));
  assert.match(tag,/^"[0-9a-f]{32}"$/);
  assert.equal(overviewTag(await accountOverview(again.store,'owner-a',config.defaultRisk)),tag);
  assert.notEqual(overviewTag(await accountOverview(moved.store,'owner-a',config.defaultRisk)),tag);
  assert.notEqual(overviewTag(await accountOverview(fixture({globalKill:true}).store,'owner-a',config.defaultRisk)),tag);
  assert.notEqual(overviewTag(await accountOverview(first.store,'owner-b',config.defaultRisk)),tag);
  for(const header of [tag,'W/'+tag,'"x", '+tag,'*'])assert.equal(notModified(header,tag),true,header);
  for(const header of [undefined,'','"x"',tag.slice(1,-1),'W/"x"'])assert.equal(notModified(header,tag),false,String(header));
});

// The real dispatcher and limiter; the route runs where server.js mounts it, after the session check.
function pipeline(store){
  const events=[],keys=[];let failCommit=false;
  const dispatch=createDispatcher({
    newsWindowsPort:{handle:async()=>false},
    requestLimits:createRequestLimits({limit:async key=>{keys.push(key);return true;},sourceKey:()=>'127.0.0.1'}),
    auth:{checkOrigin(){events.push('origin');},async prepareSession(){events.push('session');}},
    database:{transaction:async(fn,{isolation})=>{events.push('tx:'+isolation);const value=await fn();if(failCommit)throw Object.assign(new Error('serialization failure'),{code:'40001'});return value;}},
    store:{audit:async()=>{}},
    preloadJson:async()=>{},
    handleRequest:async(req,res)=>{
      const url=new URL(req.url,'http://localhost');
      if(!await overviewRoute(req,res,url,{id:'owner-a'},{store,json,defaultRisk:config.defaultRisk}))json(res,404,{error:'Not found'});
    },
    runMarketDeferred:async()=>null
  });
  const send=async(url,headers={})=>{
    events.length=0;keys.length=0;
    const set=new Map();
    const res={headersSent:false,status:null,written:null,body:null,
      setHeader(name,value){set.set(name.toLowerCase(),value);},removeHeader(name){set.delete(name.toLowerCase());},
      writeHead(status,extra){this.status=status;this.written={...Object.fromEntries(set),...extra};this.headersSent=true;},
      end(body){this.body=body===undefined?'':String(body);}};
    await dispatch({url,method:'GET',headers,socket:{remoteAddress:'127.0.0.1'}},res);
    return {status:res.status,headers:res.written,body:res.body,events:[...events],keys:[...keys]};
  };
  return {send,failNextCommit(){failCommit=true;}};
}

test('through the dispatcher: API bucket, SERIALIZABLE read, ETag on 200, empty 304, no validator on an error',async()=>{
  const {store}=fixture();
  const {send,failNextCommit}=pipeline(store);
  const full=await send(OVERVIEW_PATH+'?bot_id=all');
  assert.equal(full.status,200);
  assert.deepEqual(full.keys,['request:127.0.0.1'],'one API-bucket attempt per refresh');
  assert.deepEqual(full.events,['origin','session','tx:SERIALIZABLE']);
  assert.match(full.headers.etag,/^"[0-9a-f]{32}"$/);
  assert.equal(full.headers['cache-control'],'no-store');
  assert.equal(full.headers.etag,overviewTag(JSON.parse(full.body)),'the tag covers the exact bytes sent');
  const same=await send(OVERVIEW_PATH,{'if-none-match':full.headers.etag});
  assert.equal(same.status,304);assert.equal(same.body,'');
  assert.deepEqual(same.headers,{etag:full.headers.etag,'cache-control':'no-store'});
  const stale=await send(OVERVIEW_PATH,{'if-none-match':'"0000"'});
  assert.equal(stale.status,200);assert.equal(stale.body,full.body);
  failNextCommit();
  const failed=await send(OVERVIEW_PATH);
  assert.equal(failed.status,409);
  assert.equal(failed.headers.etag,undefined,'a rolled-back read never hands out a validator');
});

test('answer size stays small: measured bytes for 1, 5 and 10 Bots',async t=>{
  const sizes={};
  for(const bots of [1,5,10]){
    const {store,statements}=fixture({bots,positionsPerBot:2});
    const bytes=Buffer.byteLength(JSON.stringify(await accountOverview(store,'owner-a',config.defaultRisk)));
    sizes[bots]={bytes,statements:statements.length};
    assert.ok(bytes<6000*bots,bots+' Bots: '+bytes+' bytes');
    assert.equal(statements.length,3+16*bots);
  }
  t.diagnostic('overview size '+JSON.stringify(sizes));
});

test('server.js mounts the overview after the session and permission check and before bot_id scoping',()=>{
  const server=fs.readFileSync(new URL('../src/postgres/server.js',import.meta.url),'utf8');
  const mount=server.indexOf("if (await overviewRoute(req, res, url, actor, {store, json, defaultRisk: config.defaultRisk})) return;");
  assert.ok(mount>0);
  assert.equal(server.split('overviewRoute(').length-1,1);
  const routes=server.indexOf('async function userRoutes(req, res, url) {');
  assert.ok(routes>0&&routes<server.indexOf('const actor = await requireSession(req, res);',routes));
  assert.ok(server.indexOf("hasPermission(actor, req.method === 'GET' ? 'own:read' : 'own:write')",routes)<mount);
  assert.ok(mount<server.indexOf("const requestedBot = String(url.searchParams.get('bot_id') || actor.id),",routes));
});