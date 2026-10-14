import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {ExecutionWorker} from '../../src/postgres/worker.js';
import {normalizeSignal} from '../../src/postgres/domain.js';
import {config} from '../../src/config.js';
import {rolePasswordClause} from '../helpers/test-role-password.mjs';
import {assertReadOnly,readOnlySession} from '../../scripts/check-paper-ledger.mjs';

// S5b read-only Paper ledger detection. Each Q1-Q7 signature is seeded on a throwaway database next to a clean Bot that must never
// appear; every Bot and row here is a LABELLED FIXTURE. The script runs as a child process, as the operations worker would run it.
const run=promisify(execFile);
const repoRoot=fileURLToPath(new URL('../../',import.meta.url));
const script='scripts/check-paper-ledger.mjs';
let admin,db,store,name,reader;
const databases=[];
const urlOf=(database,user)=>{const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+database;if(user)url.username=user;return url.toString();};
// The child is its own process: a nested NODE_TEST_CONTEXT would change how it reports.
const childEnv=extra=>{const env={...process.env,...extra};delete env.NODE_TEST_CONTEXT;return env;};
const cli=(url,...args)=>run(process.execPath,[script,...args],{cwd:repoRoot,env:childEnv({DATABASE_URL:url})});
const cliWith=(extra,...args)=>run(process.execPath,[script,...args],{cwd:repoRoot,env:childEnv(extra)});
const MINUTE=60000;
const policy=()=>({...structuredClone(config.defaultRisk),maxTradesPerDay:100,maxOpenPositions:10,blockHighVolatility:false,blockDuringNews:false,
  equities:{'binance-global':100},balances:{'binance-global':100}});
const signal=(overrides={})=>normalizeSignal({trade_id:randomUUID(),broker:'Binance Global',symbol:'BTCUSD',event:'BUY',quantity:'1',entry:'0.1',sl:'0.09',timestamp:Date.now(),...overrides});
async function bot(label,{funded=false}={}){
  const user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:'fixture',role:'ADMIN'});
  if(funded)await store.setRisk(user.id,policy());
  return user.id;
}
async function queued(userId){const s=signal();await store.enqueue(userId,s);return (await db.query('SELECT id FROM signals WHERE user_id=$1 AND trade_id=$2',[userId,s.tradeId])).rows[0].id;}
// A signal row that only anchors a fixture lot; it is closed so the worker and Q4 never see it.
async function anchor(userId){const id=await queued(userId);await db.query("UPDATE signals SET status='REJECTED' WHERE id=$1",[id]);return id;}
async function lot(userId,{remaining,price}){
  const id='pos_fixture_'+randomUUID();
  await db.query(`INSERT INTO ledger_position_allocations(position_id,user_id,account_id,execution_mode,broker,symbol,entry_signal_id,entry_trade_id,status,
    filled_quantity,remaining_quantity,entry_price,opened_at,updated_at) VALUES($1,$2,'binance-global:primary','PAPER','binance-global','BTCUSD',$3,'fixture','OPEN',$4,$4,$5,1,1)`,
    [id,userId,await anchor(userId),remaining,price]);
  return id;
}
const position=(userId,{quantity,cost})=>db.query(`INSERT INTO ledger_positions(user_id,account_id,execution_mode,broker,symbol,quantity,avg_price,updated_at,cost_basis)
  VALUES($1,'binance-global:primary','PAPER','binance-global','BTCUSD',$2,0,1,$3)`,[userId,quantity,cost]);
// Every row of every public table, hashed: equal before and after a run means the run wrote nothing.
async function digest(target){
  const tables=(await target.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename),data={};
  for(const table of tables){assert.match(table,/^[a-z_0-9]+$/);data[table]=(await target.query('SELECT * FROM public.'+table)).rows.map(row=>JSON.stringify(Object.fromEntries(Object.entries(row).sort()))).sort();}
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
const seeded={};

before(async()=>{
  assert.ok(process.env.TEST_DATABASE_URL,'TEST_DATABASE_URL is required; isolated PostgreSQL only');
  admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  name='robot_ledger_check_'+randomUUID().replaceAll('-','');databases.push(name);
  await admin.query('CREATE DATABASE '+name);
  db=new PostgresDatabase({connectionString:urlOf(name),max:4});await db.migrate();store=new Store(db);
  // Clean control: funded, one real fill (lot, position, journal and snapshots agree), a run started after it, a fresh QUEUED signal.
  seeded.clean=await bot('clean',{funded:true});
  await queued(seeded.clean);
  assert.equal(await new ExecutionWorker({store,config}).tick(),true);
  await store.transitionBotState(seeded.clean,'run',policy());
  seeded.freshSignal=await queued(seeded.clean);
  // Q1: funding rows that take cash below zero on two brokers of one Bot (two occurrences, one Bot id).
  seeded.negative=await bot('negative-cash',{funded:true});
  await db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',2,-150,-150,'CONFIGURATION')",[seeded.negative]);
  await db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-th',2,-1,-1,'CONFIGURATION')",[seeded.negative]);
  // Q2: a FUNDING snapshot that did not see the position cost of the FILL snapshot before it.
  seeded.stale=await bot('stale-funding');
  await db.query("INSERT INTO paper_snapshots(user_id,broker,at,reason,cash,book_equity,position_cost) VALUES($1,'binance-global',1,'FILL',90,100,10)",[seeded.stale]);
  seeded.staleSnapshot=(await db.query("INSERT INTO paper_snapshots(user_id,broker,at,reason,cash,book_equity,position_cost) VALUES($1,'binance-global',2,'FUNDING',100,100,0) RETURNING id",[seeded.stale])).rows[0].id;
  // Q3: a run baseline that is not the cash at its start.
  seeded.baseline=await bot('baseline',{funded:true});
  await db.query(`INSERT INTO bot_sessions(user_id,state,run_id,locked_policy,initial_capital,started_at,updated_at) VALUES($1,'RUNNING',$2,'{}',$3,$4,$4)`,
    [seeded.baseline,randomUUID(),JSON.stringify({'binance-global':'999'}),Date.now()]);
  // Q4: a QUEUED signal ten minutes old, with every execution heartbeat ten minutes old too.
  seeded.stuck=await bot('stuck');
  seeded.stuckSignal=await queued(seeded.stuck);
  await db.query('UPDATE signals SET received_at=received_at-$2 WHERE id=$1',[seeded.stuckSignal,10*MINUTE]);
  await db.query("UPDATE worker_heartbeats SET last_tick=last_tick-$1 WHERE role='execution'",[10*MINUTE]);
  // Q5: an open lot whose full take has 36 decimal places; its position agrees with it.
  seeded.o3=await bot('o3-lot');
  seeded.o3Lot=await lot(seeded.o3,{remaining:'0.333333333333333333',price:'0.333333333333333333'});
  await position(seeded.o3,{quantity:'0.333333333333333333',cost:'0.111111111111111111'});
  // Q6: lots holding more than the position. Q6b: a position holding more than its lots (legacy, legitimate under G1).
  seeded.overLotted=await bot('lots-exceed');
  await lot(seeded.overLotted,{remaining:'2',price:'100'});await position(seeded.overLotted,{quantity:'1',cost:'100'});
  seeded.unlotted=await bot('unlotted');
  await lot(seeded.unlotted,{remaining:'1',price:'100'});await position(seeded.unlotted,{quantity:'3',cost:'300'});
  // Q7: a flat position that still carries cost.
  seeded.flat=await bot('cost-at-flat');
  await position(seeded.flat,{quantity:'0',cost:'5'});
  // A login role that may only read, as an operations read account would be.
  reader='robot_ledger_reader_'+randomUUID().replaceAll('-','').slice(0,12);
  await admin.query('CREATE ROLE '+reader+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  await db.query('GRANT USAGE ON SCHEMA public TO '+reader);await db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO '+reader);
});
after(async()=>{
  await db?.close().catch(()=>{});
  for(const database of databases)await admin?.query('DROP DATABASE IF EXISTS '+database+' WITH (FORCE)').catch(()=>{});
  if(admin){if(reader)await admin.query('DROP ROLE IF EXISTS '+reader);await admin.close();}
});

test('every seeded signature is counted once, the clean Bot never appears, and the run writes nothing',async()=>{
  const before=await digest(db);
  const {stdout,stderr}=await cli(urlOf(name));
  assert.equal(stderr,'');
  const report=JSON.parse(stdout),q=report.queries;
  assert.equal(report.read_only,true);assert.equal(report.server_version_num>=160000,true);
  assert.equal(report.isolation,'repeatable read');assert.equal(report.incomplete,false);
  for(const [key,entry] of Object.entries(q))assert.equal(entry.status,'OK',key);
  assert.match(q.Q4_stuck_queued.detects,/pre-W1 stall signature/);assert.ok(!/Paper/.test(q.Q4_stuck_queued.detects),'Q4 does not filter Paper');
  const only=(entry,id)=>{assert.equal(entry.count,1);assert.deepEqual(entry.bot_ids,[id]);assert.equal(entry.truncated,false);};
  assert.equal(q.Q1_negative_cash.count,2);assert.deepEqual(q.Q1_negative_cash.bot_ids,[seeded.negative],'one Bot id for its two brokers');
  only(q.Q2_funding_missed_fill,seeded.stale);assert.deepEqual(q.Q2_funding_missed_fill.snapshot_ids,[String(seeded.staleSnapshot)]);
  only(q.Q4_stuck_queued,seeded.stuck);assert.deepEqual(q.Q4_stuck_queued.signal_ids,[String(seeded.stuckSignal)]);
  assert.ok(q.Q4_stuck_queued.oldest_age_ms>=10*MINUTE);
  only(q.Q5_o3_exposed_lots,seeded.o3);assert.deepEqual(q.Q5_o3_exposed_lots.lot_ids,[seeded.o3Lot]);
  only(q.Q6_lots_exceed_position,seeded.overLotted);
  only(q.Q6b_unlotted_quantity,seeded.unlotted);assert.equal(q.Q6b_unlotted_quantity.kind,'info','unlotted quantity is legitimate under G1');
  only(q.Q7_cost_at_flat,seeded.flat);
  assert.equal(q.Q3_run_baselines.count,2);assert.deepEqual([...q.Q3_run_baselines.bot_ids].sort(),[seeded.clean,seeded.baseline].sort());
  assert.equal(q.Q3_run_baselines.differs_count,1);assert.deepEqual(q.Q3_run_baselines.differs_bot_ids,[seeded.baseline],'the clean run baseline equals its cash at start');
  assert.ok(report.heartbeats.execution.length>=1&&report.heartbeats.execution.every(age=>age>=10*MINUTE));
  assert.equal(report.stall_signature,true);
  assert.deepEqual(report.summary,{findings:6,exposure:1,info:1,review_differs:1});
  for(const entry of Object.values(q))assert.ok(!JSON.stringify(entry).includes(seeded.clean)||entry===q.Q3_run_baselines,'the clean Bot is never a finding');
  assert.ok(!stdout.includes('@')&&!stdout.includes('example.test'),'no email in the output');
  const url=new URL(process.env.TEST_DATABASE_URL);
  assert.ok(!stdout.includes(name)&&!stdout.includes(url.host)&&(!url.password||!stdout.includes(url.password)),'no connection detail in the output');
  assert.equal(await digest(db),before,'the run wrote nothing');
});

test('a reader with SELECT only gets the same counts, and --self-check proves the session refuses a write',async()=>{
  const owner=JSON.parse((await cli(urlOf(name))).stdout),limited=JSON.parse((await cli(urlOf(name,reader))).stdout);
  const counts=report=>Object.fromEntries(Object.entries(report.queries).map(([key,value])=>[key,value.count]));
  assert.deepEqual(counts(limited),counts(owner));
  const check=JSON.parse((await cli(urlOf(name,reader),'--self-check')).stdout);
  assert.deepEqual(check,{tool:'check-paper-ledger',self_check:'ok',read_only:true});
});

test('inside the session a write fails with 25006, and a session that is not read only is refused before any check',async()=>{
  const client=new pg.Client({connectionString:urlOf(name)});await client.connect();
  try{
    await assert.rejects(readOnlySession(client,()=>client.query("INSERT INTO system_settings(key,value) VALUES('ledger-check-fixture','x')")),{code:'25006'});
    assert.equal((await client.query("SELECT count(*)::int n FROM system_settings WHERE key='ledger-check-fixture'")).rows[0].n,0);
    await client.query('BEGIN');
    await assert.rejects(assertReadOnly(client),{code:'CHECK_PAPER_LEDGER_NOT_READ_ONLY'});
    await client.query('ROLLBACK');
    // The right isolation alone is not enough: a REPEATABLE READ transaction that may write is refused too.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await assert.rejects(assertReadOnly(client),{code:'CHECK_PAPER_LEDGER_NOT_READ_ONLY'});
    await client.query('ROLLBACK');
  }finally{await client.end();}
});

test('a clean database reports zero everywhere; a bad argument or no database exits non-zero without printing the connection',async()=>{
  const empty='robot_ledger_check_empty_'+randomUUID().replaceAll('-','').slice(0,16);databases.push(empty);
  await admin.query('CREATE DATABASE '+empty);
  const fresh=new PostgresDatabase({connectionString:urlOf(empty),max:2});
  try{await fresh.migrate();}finally{await fresh.close();}
  const report=JSON.parse((await cli(urlOf(empty))).stdout);
  for(const [key,entry] of Object.entries(report.queries))assert.equal(entry.count,0,key);
  assert.deepEqual(report.summary,{findings:0,exposure:0,info:0,review_differs:0});assert.equal(report.stall_signature,false);
  // More occurrences than the cap: the count stays exact and the id list stops at 50.
  const seed=new PostgresDatabase({connectionString:urlOf(empty),max:2});
  try{
    for(let i=0;i<51;i++){
      const id=randomUUID();
      await seed.query("INSERT INTO users(id,email,password_hash,created_at) VALUES($1,$2,'fixture',1)",[id,id+'@example.test']);
      await seed.query(`INSERT INTO ledger_positions(user_id,account_id,execution_mode,broker,symbol,quantity,avg_price,updated_at,cost_basis)
        VALUES($1,'binance-global:primary','PAPER','binance-global','BTCUSD',0,0,1,1)`,[id]);
    }
  }finally{await seed.close();}
  const capped=JSON.parse((await cli(urlOf(empty))).stdout).queries.Q7_cost_at_flat;
  assert.equal(capped.count,51);assert.equal(capped.bot_ids.length,50);assert.equal(capped.truncated,true);
  await assert.rejects(cli(urlOf(empty),'--write'),error=>error.code===2&&/USAGE/.test(error.stderr));
  await assert.rejects(run(process.execPath,[script],{cwd:repoRoot,env:childEnv({DATABASE_URL:''})}),error=>error.code===2);
  const unreachable=new URL(process.env.TEST_DATABASE_URL);unreachable.port='1';unreachable.pathname='/'+empty;
  await assert.rejects(cli(unreachable.toString()),error=>error.code===1&&/CHECK_PAPER_LEDGER_FAILED/.test(error.stderr)&&
    !error.stderr.includes(unreachable.host)&&!error.stderr.includes(empty)&&error.stdout==='');
});

test('a malformed DATABASE_URL exits 1 with one JSON line: no stack, no path and no connection text',async()=>{
  for(const value of ['postgres://fixture_user:se%cret#pw@127.0.0.1:1/fixture_db','postgres://fixture_user:pw@127.0.0.1:notaport/fixture_db',
    'postgres://fixture_user:pw@[bad-host:1/fixture_db','not a url fixture_db']){
    await assert.rejects(cliWith({DATABASE_URL:value}),error=>{
      assert.equal(error.code,1,value);assert.equal(error.stdout,'',value);
      const lines=error.stderr.trim().split('\n');
      assert.equal(lines.length,1,value+': one line');
      const printed=JSON.parse(lines[0]);
      assert.equal(printed.error,'CHECK_PAPER_LEDGER_FAILED',value);
      for(const leak of ['postgres','fixture_user','fixture_db','cret','node_modules','scripts',String.fromCharCode(92),'    at '])assert.ok(!error.stderr.includes(leak),value+': '+leak);
      return true;
    });
  }
});

test('under a serializable server default the report still runs as one REPEATABLE READ READ ONLY snapshot',async()=>{
  const serial='robot_ledger_check_serial_'+randomUUID().replaceAll('-','').slice(0,16);databases.push(serial);
  await admin.query('CREATE DATABASE '+serial);
  const fresh=new PostgresDatabase({connectionString:urlOf(serial),max:2});
  try{await fresh.migrate();}finally{await fresh.close();}
  await admin.query('ALTER DATABASE '+serial+" SET default_transaction_isolation='serializable'");
  const client=new pg.Client({connectionString:urlOf(serial)});await client.connect();
  try{
    assert.equal((await client.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation,'serializable');
    assert.deepEqual(await readOnlySession(client,async()=>({
      isolation:(await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation,
      readOnly:(await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,
      parallel:(await client.query('SHOW max_parallel_workers_per_gather')).rows[0].max_parallel_workers_per_gather})),
      {isolation:'repeatable read',readOnly:'on',parallel:'0'});
    // A serializable read-only transaction is refused: it is not one REPEATABLE READ snapshot.
    await client.query('BEGIN READ ONLY');
    await assert.rejects(assertReadOnly(client),{code:'CHECK_PAPER_LEDGER_NOT_READ_ONLY'});
    await client.query('ROLLBACK');
  }finally{await client.end();}
  const report=JSON.parse((await cli(urlOf(serial))).stdout);
  assert.equal(report.isolation,'repeatable read');assert.equal(report.incomplete,false);
  assert.deepEqual(report.summary,{findings:0,exposure:0,info:0,review_differs:0});
});

test('a check that passes its statement or lock timeout reports only its status; the others still report and the run exits 0',async()=>{
  const holder=new pg.Client({connectionString:urlOf(name)});await holder.connect();
  try{
    // Only Q2 reads paper_snapshots, so only Q2 waits for this lock.
    await holder.query('BEGIN');await holder.query('LOCK TABLE public.paper_snapshots IN ACCESS EXCLUSIVE MODE');
    const statement=JSON.parse((await cliWith({DATABASE_URL:urlOf(name),CHECK_PAPER_LEDGER_TEST_STATEMENT_TIMEOUT_MS:'2000'})).stdout);
    assert.equal(statement.incomplete,true);
    assert.deepEqual(statement.queries.Q2_funding_missed_fill,{kind:'finding',detects:statement.queries.Q2_funding_missed_fill.detects,status:'TIMEOUT'});
    assert.equal(statement.queries.Q1_negative_cash.count,2);assert.equal(statement.queries.Q7_cost_at_flat.count,1);assert.equal(statement.queries.Q3_run_baselines.differs_count,1);
    for(const [key,entry] of Object.entries(statement.queries))if(key!=='Q2_funding_missed_fill')assert.equal(entry.status,'OK',key);
    assert.deepEqual(statement.summary,{findings:5,exposure:1,info:1,review_differs:1},'Q2 is left out of the totals');
    const lock=JSON.parse((await cli(urlOf(name))).stdout);
    assert.equal(lock.incomplete,true);assert.equal(lock.queries.Q2_funding_missed_fill.status,'LOCK_TIMEOUT');assert.equal(lock.queries.Q2_funding_missed_fill.count,undefined);
    assert.equal(lock.queries.Q4_stuck_queued.count,1);
  }finally{await holder.query('ROLLBACK').catch(()=>{});await holder.end();}
  for(const value of ['0','15001','fast'])
    await assert.rejects(cliWith({DATABASE_URL:urlOf(name),CHECK_PAPER_LEDGER_TEST_STATEMENT_TIMEOUT_MS:value}),error=>error.code===2&&/USAGE/.test(error.stderr),value);
});
