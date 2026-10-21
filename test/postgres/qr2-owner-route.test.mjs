import test from 'node:test';
import assert from 'node:assert/strict';
import {qr2OwnerPerformanceRoute} from '../../src/postgres/qr2-owner-route.js';
import {createQr2Slot,parseQr2OwnerParameters} from '../../src/postgres/qr2-routes.js';
import {LOCAL_FIXTURE_E2} from '../helpers/qr2-reader-fixture.mjs';
import {readQr2OwnerSnapshot,QR2_OWNER_BROKERS,ownerReadLimits} from '../../src/postgres/qr2-owner-reader.js';
const now=1790812800000+86400000,base='http://local/api/paper-performance/owner';
const url=query=>new URL(base+'?'+query);
const code=(fn,value)=>assert.throws(fn,e=>e.code===value);
function harness(over={}){
  const writes=[],reads=[];
  const store={userById:async id=>({id,parent_user_id:null,created_at:now-86400000}),activePlan:async()=> 'ENTERPRISE'};
  const deps={store,json:(res,status,body)=>writes.push({status,body}),enabled:true,slot:createQr2Slot(),clock:()=>now,
    readSnapshot:async(_,args)=>{reads.push(args);return {snapshot:{kind:'owner'},input:{kind:'owner'}};},compute:{run:async()=>{throw Object.assign(new Error('SECRET SQL'),{kind:'timeout'});}},...over};
  const res={setHeader:(key,value)=>{res[key]=value;}};
  return {deps,res,writes,reads,route:async(query='currency=USDT&period=DAY',actor={id:'owner'})=>qr2OwnerPerformanceRoute({method:'GET'},res,url(query),actor,deps)};
}
test('owner strict selectors reject duplicates, missing currency, broker/admin/owner overrides',()=>{
  for(const query of ['period=DAY','currency=BTC','currency=USDT&currency=THB','currency=USDT&bot_id=x','currency=USDT&owner_id=x','currency=USDT&broker=settrade','currency=USDT&admin=1'])code(()=>parseQr2OwnerParameters(url(query),now),'QR2_INPUT_INVALID');
  code(()=>parseQr2OwnerParameters(url('currency=USDT&fee_bps=1'),now),'QR2_FEE_OVERLAY_REFUSED');
  code(()=>parseQr2OwnerParameters(url('currency=USDT&period=CUSTOM&from=2026-02-30&to=2026-03-01'),now),'QR2_INPUT_INVALID');
});
test('owner gate off avoids auth and read; child actor refused; own ADMIN uses actor only',async()=>{
  const off=harness({enabled:false,store:{userById:()=>{throw Error('must not read');}}});assert.equal(await off.route(),false);
  const child=harness({store:{userById:async()=>({id:'child',parent_user_id:'owner'})}});await child.route();assert.equal(child.writes[0].status,404);
  const admin=harness();await admin.route('currency=THB&period=DAY',{id:'admin',role:'ADMIN'});assert.equal(admin.writes.length,0);
  await admin.res.phase2Deferred();assert.equal(admin.reads[0].ownerId,'admin');assert.equal(admin.reads[0].currency,'THB');
});
test('all periods enforce history quota including ALL_TIME',async()=>{
  for(const period of ['ALL_TIME','YEAR','CUSTOM']){
    const h=harness({store:{userById:async()=>({id:'owner',created_at:now-400*86400000}),activePlan:async()=> 'FREE'}});
    await h.route('currency=USDT&period='+period+(period==='CUSTOM'?'&from=2025-01-01&to=2025-01-02':''));
    assert.equal(h.writes[0].status,403,period);assert.equal(h.res.phase2Deferred,undefined);
  }
});
test('same slot blocks owner and account overlap; timeout sanitized, slot released, no audit',async()=>{
  const h=harness(),held=h.deps.slot.tryAcquire();await h.route();
  assert.equal((await h.res.phase2Deferred()).status,429);assert.equal(h.reads.length,0);held();
  const result=await h.res.phase2Deferred();assert.equal(result.status,503);assert.equal(h.res['Retry-After'],'2');
  assert.equal(JSON.stringify(result).includes('SECRET'),false);assert.equal(h.deps.slot.busy,0);assert.equal(h.res.phase2AfterCommit,undefined);
});

// SQL mocks exercise phase boundaries without running a DB. Integration/snapshot races require root's isolated PostgreSQL runner.
function admissionStore({fundings=0,positions=0,exposure=0,audit=0,pending=0,grid=2,bots=['owner'],currency='USDT'}={}){
  const queries=[];
  const db={isTransaction:false,transaction:async fn=>fn(),query:async(sql,args=[])=>{
    queries.push(sql);
    if(sql==='SHOW transaction_isolation')return {rows:[{transaction_isolation:'repeatable read'}]};
    if(sql==='SHOW transaction_read_only')return {rows:[{transaction_read_only:'on'}]};
    if(sql==='SET TRANSACTION READ ONLY')return {rows:[]};
    if(sql.startsWith('SELECT id,parent_user_id'))return {rows:[{id:'owner',parent_user_id:null,created_at:now-86400000}]};
    if(sql.startsWith('SELECT id,created_at'))return {rows:bots.map(id=>({id,created_at:now-86400000}))};
    if(sql.includes('paper_capital_models'))return {rows:sql.includes('count(*)')?[{n:0}]:[]};
    if(sql.includes('AS fundings'))return {rows:[{fundings,journal:0,fills:0,lots:0,snapshots:0}]};
    if(sql.includes('public.ledger_positions'))return {rows:[{n:sql.includes('account_id')?exposure:positions}]};
    if(sql.includes('public.audit'))return {rows:[{n:audit}]};
    if(sql.includes('public.signals WHERE'))return {rows:[{n:pending}]};
    if(sql.includes(') grid'))return {rows:[{n:grid}]};
    throw new Error('DETAILS_FETCHED_BEFORE_ADMISSION');
  }};
  return {store:{db},queries,args:{ownerId:'owner',currency,from:now-86400000,to:now,requestTime:now,boundaries:LOCAL_FIXTURE_E2}};
}
test('whole-batch ledger/audit/pending/grid limits refuse before any member history materializes',async()=>{
  for(const [options,limit] of [[{fundings:2501,bots:['owner','bot']},'ledger_rows'],[{fundings:1,audit:1001,bots:['owner','bot']},'audit_rows'],[{fundings:1,pending:501,bots:['owner','bot']},'pending_orders'],[{fundings:1,grid:2501,bots:['owner','bot']},'grid_instants'],[{positions:5001},'ledger_rows'],[{positions:1,exposure:5000},'ledger_rows']]){
    const f=admissionStore(options);
    await assert.rejects(readQr2OwnerSnapshot(f.store,f.args),e=>e.code==='QR2_RANGE_ADMISSION_REFUSED'&&e.detail.limit===limit,limit);
    assert.equal(f.queries.some(q=>q.startsWith('SELECT id,user_id,broker,at,equity_delta')),false);
  }
});
test('owner limits cannot increase; broker map keeps currencies separate; journal pre-count includes foreign branch',async()=>{
  code(()=>ownerReadLimits({ledger_rows:5001}),'QR2_INPUT_INVALID');
  assert.deepEqual(QR2_OWNER_BROKERS.THB,['binance-th','innovestx','settrade']);assert.deepEqual(QR2_OWNER_BROKERS.USDT,['binance-global']);
  const f=admissionStore({positions:5001});await assert.rejects(readQr2OwnerSnapshot(f.store,f.args));
  const count=f.queries.find(q=>q.includes('AS fundings'));assert.match(count,/WHERE j.user_id=\$1/);assert.match(count,/WHERE s.user_id=\$1 AND s.broker=\$2/);
});

import fs from 'node:fs/promises';
import {createQr2Database,createOwner,openSecond} from '../helpers/qr2-reader-fixture.mjs';
import {appendCapitalModelDeclaration} from '../../src/postgres/qr2-capital-model-route.js';
import {executeQr2Job} from '../../src/postgres/qr2-compute-worker.js';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
const ddl=()=>fs.readFile(new URL('../../src/postgres/paper-capital-model.sql',import.meta.url),'utf8');

// Real isolated PostgreSQL: counts at exact lowered ceilings and one above each ceiling; all history reads observed.
test('S45 PostgreSQL whole-batch exact/+1 admission and repeated THB audit/grid materialization',async()=>{
  const f=await createQr2Database('robot_qr2_owner');
  try{
    await f.db.query(await ddl());
    const owner=await createOwner(f.store),start=Math.floor(Date.now()/86400000)*86400000-86400000,end=start+86400000;
    await f.db.query('UPDATE users SET created_at=$2 WHERE id=$1',[owner.id,start-1]);
    // Explicit synthetic history: same instants in all brokers count separately for every member.
    for(const broker of QR2_OWNER_BROKERS.THB){
      await f.db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) SELECT $1,$2,$3::bigint+i,1,1,'CONFIGURATION' FROM generate_series(1,3) i",[owner.id,broker,start]);
      await f.db.query("INSERT INTO signals(user_id,trade_id,received_at,signal_time,broker,symbol,event,side,payload,status,execution_mode,account_id) SELECT $1,$2||i,$3,$3,$2,'BTCUSDT','BUY','BUY','{}','PROCESSING','PAPER',$2||':primary' FROM generate_series(1,2) i",[owner.id,broker,start]);
    }
    await f.db.query("INSERT INTO audit(user_id,ts,event,details) SELECT $1,$2,'ledger.cost_clamped','{}' FROM generate_series(1,2)",[owner.id,start]);
    const args={ownerId:owner.id,currency:'THB',from:start,to:end,requestTime:end,boundaries:LOCAL_FIXTURE_E2};
    const baseline=await readQr2OwnerSnapshot(f.store,args);
    assert.equal(baseline.snapshot.accounts.length,3);assert.equal(baseline.snapshot.counts.audit_rows,6);assert.equal(baseline.snapshot.counts.pending_orders,6);
    assert.equal(baseline.snapshot.counts.grid_instants,15);assert.equal(baseline.snapshot.counts.ledger_rows,9);
    const exact=Object.fromEntries(['ledger_rows','grid_instants','audit_rows','pending_orders'].map(k=>[k,baseline.snapshot.counts[k]]));
    assert.equal((await readQr2OwnerSnapshot(f.store,{...args,limits:exact})).snapshot.accounts.length,3);
    const original=f.db.query.bind(f.db);let detailReads=0;
    f.db.query=async(sql,...rest)=>{if(sql.startsWith('SELECT id,user_id,broker,at,equity_delta'))detailReads++;return original(sql,...rest);};
    for(const name of Object.keys(exact)){
      detailReads=0;
      await assert.rejects(readQr2OwnerSnapshot(f.store,{...args,limits:{[name]:exact[name]-1}}),e=>e.code==='QR2_RANGE_ADMISSION_REFUSED'&&e.detail.limit===name);
      assert.equal(detailReads,0,name+' must refuse before any member history');
    }
    f.db.query=original;
    assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM paper_capital_models')).rows[0].n),0);
  }finally{await f.dispose();}
});

test('S45 PostgreSQL one RR snapshot excludes concurrent membership, declaration and funding commits',async()=>{
  const f=await createQr2Database('robot_qr2_owner_snapshot');let second;
  try{
    await f.db.query(await ddl());second=openSecond(f);
    const owner=await createOwner(f.store),start=Math.floor(Date.now()/86400000)*86400000-86400000,end=start+86400000;
    await f.db.query('UPDATE users SET created_at=$2 WHERE id=$1',[owner.id,start-1]);
    await f.db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,10,10,'CONFIGURATION')",[owner.id,start+1]);
    const original=f.db.query.bind(f.db);let injected=false;
    f.db.query=async(sql,...rest)=>{
      const result=await original(sql,...rest);
      // Owner SELECT has established the read snapshot. Changes commit through an independent pool before membership reads.
      if(!injected&&sql.startsWith('SELECT id,parent_user_id,created_at')){
        injected=true;
        await second.db.transaction(()=>appendCapitalModelDeclaration(second.store,{ownerId:owner.id,currency:'USDT',capitalModel:'INDEPENDENT_ACCOUNTS'}),{isolation:'SERIALIZABLE'});
        const child=await createOwner(second.store);
        await second.db.query('UPDATE users SET parent_user_id=$2,bot_slot_index=2,created_at=$3 WHERE id=$1',[child.id,owner.id,start-1]);
        await second.db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,20,20,'CONFIGURATION')",[owner.id,start+2]);
      }
      return result;
    };
    const read=await readQr2OwnerSnapshot(f.store,{ownerId:owner.id,currency:'USDT',from:start,to:end,requestTime:end,boundaries:LOCAL_FIXTURE_E2});
    f.db.query=original;
    assert.equal(injected,true);assert.equal(read.snapshot.ownerBots.length,1);assert.equal(read.snapshot.declarations.length,0);
    assert.equal(read.snapshot.accounts[0].snapshot.fundings.length,1);
    const fresh=await readQr2OwnerSnapshot(f.store,{ownerId:owner.id,currency:'USDT',from:start,to:end,requestTime:end,boundaries:LOCAL_FIXTURE_E2});
    assert.equal(fresh.snapshot.ownerBots.length,2);assert.equal(fresh.snapshot.declarations.length,1);assert.equal(fresh.snapshot.accounts[0].snapshot.fundings.length,2);
  }finally{await second?.close();await f.dispose();}
});

test('S45 PostgreSQL position-only non-Paper and foreign journal discovery refuse without financial rows',async()=>{
  const f=await createQr2Database('robot_qr2_owner_scope');
  try{
    await f.db.query(await ddl());const owner=await createOwner(f.store),foreign=await createOwner(f.store);
    const start=Math.floor(Date.now()/86400000)*86400000-86400000,end=start+86400000;
    await f.db.query('UPDATE users SET created_at=$2 WHERE id=$1',[owner.id,start-1]);
    const args={ownerId:owner.id,currency:'USDT',from:start,to:end,requestTime:end,boundaries:LOCAL_FIXTURE_E2};
    await f.db.query("INSERT INTO ledger_positions(user_id,account_id,execution_mode,broker,symbol,quantity,updated_at) VALUES($1,'binance-global:primary','LIVE','binance-global','BTCUSDT',1,$2)",[owner.id,start]);
    const rp=await readQr2OwnerSnapshot(f.store,args);assert.equal(rp.snapshot.accounts.length,1);
    const refused=executeQr2Job(rp);assert.equal(refused.ok,true);assert.equal(refused.body.code,'QR2_NON_PAPER_ROW');assert.equal(refused.body.accounts,undefined);
    await f.db.query('DELETE FROM ledger_positions WHERE user_id=$1',[owner.id]);
    const signal=(await f.db.query("INSERT INTO signals(user_id,trade_id,received_at,signal_time,broker,symbol,event,side,payload,status,execution_mode,account_id) VALUES($1,'foreign-journal-fixture',$2,$2,'binance-global','BTCUSDT','BUY','BUY','{}','FILLED','PAPER','binance-global:primary') RETURNING id",[owner.id,start])).rows[0];
    await f.db.query("INSERT INTO paper_cash_journal(signal_id,cumulative_quantity,user_id,broker,cash_delta,at) VALUES($1,1,$2,'binance-global',999,$3)",[signal.id,foreign.id,start]);
    const rx=await readQr2OwnerSnapshot(f.store,args);assert.equal(rx.snapshot.accounts.length,1);
    const response=executeQr2Job(rx);assert.equal(response.ok,true);assert.equal(response.body.code,'QR2_CROSS_BOT_ROW');
    assert.equal(JSON.stringify(response.body).includes(foreign.id),false);assert.equal(response.body.total,undefined);
  }finally{await f.dispose();}
});

test('S45 actual server requires auth, honors off gate and every-period quota, sanitizes absent schema',async()=>{
  let f,off;
  try{
    f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'disabled',environment:{QR2_PERFORMANCE_ENABLED:'1',MARKET_PUBLIC_PROXY:'0'}});
    off=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'disabled',environment:{QR2_PERFORMANCE_ENABLED:'',MARKET_PUBLIC_PROXY:'0'}});
    assert.equal((await f.request('/api/paper-performance/owner?currency=USDT','GET')).status,401);
    const session=await f.login(f.owner),offSession=await off.login(off.owner);
    assert.equal((await off.request('/api/paper-performance/owner?currency=USDT','GET',undefined,offSession)).status,404);
    await f.db.query('UPDATE users SET created_at=$2 WHERE id=$1',[f.owner.id,Date.now()-400*86400000]);
    const all=await f.request('/api/paper-performance/owner?currency=USDT&period=ALL_TIME','GET',undefined,session);
    assert.equal(all.status,403);assert.equal(all.body.code,'QR2_RANGE_ADMISSION_REFUSED');
    const absent=await f.request('/api/paper-performance/owner?currency=USDT&period=DAY','GET',undefined,session);
    assert.equal(absent.status,503);assert.equal(absent.body.code,'QR2_REPORT_FAILED');assert.equal(JSON.stringify(absent.body).includes('paper_capital_models'),false);
  }finally{await f?.close();await off?.close();}
});
