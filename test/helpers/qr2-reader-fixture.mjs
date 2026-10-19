import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {installQuantGuards} from './quant-guard-install.mjs';
import {Store} from '../../src/postgres/store.js';
import {ExecutionWorker} from '../../src/postgres/worker.js';
import {normalizeSignal} from '../../src/postgres/domain.js';
import {config} from '../../src/config.js';
import {hashPassword} from '../../src/security.js';
import {validateBoundaryRecord} from '../../src/portfolio/qr2-boundaries.js';

// QR-2 S2 reader PostgreSQL fixture. Isolated local PostgreSQL only (TEST_DATABASE_URL, one CREATE DATABASE per test file, dropped after).
// The ledger is written by the live recordFunding / recordExecution through the Store and the ExecutionWorker, with the F4 fence present.
// Rows written by direct SQL are labelled exceptions of the test that writes them. Bars carry a hash made by an independent canonical-JSON
// implementation (not the code under test). Nothing here is evidence of anything.

export const FIXTURE_LABEL='QR-2 S2 reader test fixture: synthetic rows, never evidence';
export const MINUTE=60000;
// Test-only boundary record. It lives under test/helpers and never under src: a product record needs deployment evidence (S9).
export const LOCAL_FIXTURE_E2=validateBoundaryRecord({record_id:'LOCAL_FIXTURE_E2',epochs:[{epoch:'E2',from:0,to:null}],lot_fee_boundary:0,lot_table_boundary:0,evidence:'docs/evidence/local-test-record.json'});

const sortedJson=v=>Array.isArray(v)?'['+v.map(sortedJson).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+sortedJson(v[k])).join(',')+'}':JSON.stringify(v);
export const sha=text=>createHash('sha256').update(text).digest('hex');

/** One isolated database with the application schema, the accepted guards, the Pine Bridge schema (pine_market_bars) and a real Store. */
export async function createQr2Database(prefix='robot_qr2'){
  if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL is required; tests must run on real PostgreSQL');
  const admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const name=prefix+'_'+randomUUID().replaceAll('-','');
  if(!/^robot_qr2[a-z0-9_]*_[a-f0-9]{32}$/.test(name))throw new Error('unexpected database name');
  await admin.query('CREATE DATABASE '+name);
  const target=new URL(process.env.TEST_DATABASE_URL);target.pathname='/'+name;
  const db=new PostgresDatabase({connectionString:target.toString(),max:6});
  await db.migrate();
  await installQuantGuards(db);
  await db.transaction(async()=>db.query(await fs.readFile(new URL('../../src/postgres/pine-bridge-schema.sql',import.meta.url),'utf8')));
  const store=new Store(db);
  return {db,store,name,async dispose(){await db.close().catch(()=>{});await admin.query('DROP DATABASE IF EXISTS '+name).catch(()=>{});await admin.close().catch(()=>{});}};
}

export const policyFor=(capital,thb=0)=>({...structuredClone(config.defaultRisk),maxTradesPerDay:1000,maxOpenPositions:10,maxOrderNotional:1000000,maxDailyNotional:100000000,blockHighVolatility:false,blockDuringNews:false,
  equities:{'binance-global':capital,'binance-th':thb},balances:{'binance-global':capital,'binance-th':thb}});

export async function createOwner(store){
  return store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword('temporary-test-password'),role:'ADMIN'});
}
/** A child Bot of the owner, funded with `capital` USDT by the live recordFunding (through setRisk). */
export async function createBot(store,owner,capital=10000,thb=0){
  return store.createBot(owner.id,'qr2-'+randomUUID().slice(0,8),policyFor(capital,thb));
}
/** A deposit or withdrawal through the live path: the policy sets the new total capital. */
export async function setCapital(store,bot,capital){return store.setRisk(bot.id,policyFor(capital));}

const signal=(tradeId,overrides)=>normalizeSignal({trade_id:tradeId,broker:'Binance Global',symbol:'BTCUSDT',timestamp:Date.now(),...overrides});
/** Enqueues a signal and runs the real ExecutionWorker until the queue is empty. Returns the stored signal row. */
export async function send(store,bot,tradeId,overrides){
  if(!await store.enqueue(bot.id,signal(tradeId,overrides)))throw new Error('signal was not accepted');
  const worker=new ExecutionWorker({store,config});
  for(let i=0;i<10&&Number((await store.health()).queued)>0;i++)await worker.tick();
  return store.db.prepare('SELECT * FROM signals WHERE user_id=? AND trade_id=?').get(bot.id,tradeId);
}
export const fillsOf=(db,bot)=>db.prepare('SELECT f.*,s.side,s.trade_id FROM fills f JOIN signals s ON s.id=f.signal_id WHERE s.user_id=? ORDER BY f.received_at,f.signal_id,f.cumulative_quantity').all(bot.id);

/** Stored 1m BTCUSDT bars (bar_time = close time). Labelled fixture rows with a valid hash from the independent canonical form. */
export function barOf(barTime,close,{open,high,low}={}){
  const bar={time:barTime,open:String(open??close),high:String(high??close),low:String(low??close),close:String(close),volume:'1',atr14:'1',price_tick:'0.01',quantity_step:'0.00001'};
  return {barTime,bar,hash:sha(sortedJson(bar))};
}
export async function insertBars(db,bars,{retrievedAt}={}){
  for(const {barTime,bar,hash} of bars){
    const provenance={profile:'closed-ohlcv-atr14-v1',source:FIXTURE_LABEL,...(retrievedAt===undefined?{}:{retrieved_at:retrievedAt})};
    await db.query("INSERT INTO pine_market_bars(broker,symbol,timeframe,bar_time,bar,provenance,content_hash) VALUES('binance-global','BTCUSDT','1',$1,$2::jsonb,$3::jsonb,$4)",[barTime,JSON.stringify(bar),JSON.stringify(provenance),hash]);
  }
}

/** Digest of every table the reader reads plus the fence, to prove a read changed nothing. */
export async function ledgerDigest(db,bot){
  const tables={
    paper_funding:'SELECT * FROM public.paper_funding WHERE user_id=$1 ORDER BY id',
    paper_cash_journal:'SELECT * FROM public.paper_cash_journal WHERE user_id=$1 ORDER BY signal_id,cumulative_quantity',
    fills:'SELECT f.* FROM public.fills f JOIN public.signals s ON s.id=f.signal_id WHERE s.user_id=$1 ORDER BY f.signal_id,f.cumulative_quantity',
    signals:'SELECT * FROM public.signals WHERE user_id=$1 ORDER BY id',
    lots:'SELECT * FROM public.ledger_position_allocations WHERE user_id=$1 ORDER BY position_id',
    positions:'SELECT * FROM public.ledger_positions WHERE user_id=$1 ORDER BY symbol',
    snapshots:'SELECT * FROM public.paper_snapshots WHERE user_id=$1 ORDER BY id',
    audit:'SELECT * FROM public.audit WHERE user_id=$1 ORDER BY id',
    fence:'SELECT * FROM public.paper_ledger_fence WHERE user_id=$1'
  };
  const out={};
  for(const [name,sql] of Object.entries(tables))out[name]=sha(JSON.stringify((await db.query(sql,[bot.id])).rows));
  return out;
}

/**
 * Books one signal through the live ledger writer recordExecution, with a fee and optional partial steps. The worker's paper broker has no
 * fee for a webhook signal (only a Pine Bridge deployment adds one), so a fee-bearing fill is written here: the signal is claimed with a
 * labelled direct status update (what the worker does before it executes), then recordExecution (the same function the worker calls)
 * writes fill, journal row, lot, position, snapshot and fence bump. steps: cumulative [{qty, quote, fee}] where fee is the fee of that step.
 */
export async function book(store,bot,tradeId,{side,steps,stopLoss='59000',target,symbol='BTCUSDT',broker='Binance Global'}){
  const overrides={event:side,symbol,broker,...(side==='BUY'?{quantity:steps.at(-1).qty,entry:'60000',sl:stopLoss}:{reduce_only:true,quantity:steps.at(-1).qty,entry:'60000'}),...(target?{target_trade_id:target}:{})};
  if(!await store.enqueue(bot.id,signal(tradeId,overrides)))throw new Error('signal was not accepted');
  await store.db.prepare("UPDATE signals SET status='PROCESSING' WHERE user_id=? AND trade_id=?").run(bot.id,tradeId);
  const row=await store.db.prepare('SELECT * FROM signals WHERE user_id=? AND trade_id=?').get(bot.id,tradeId);
  const total=steps.at(-1).qty,order={side,quantity:total,price:'60000',stopLoss,takeProfit:null};
  for(const [i,step] of steps.entries())
    await store.recordExecution(row,{status:i===steps.length-1?'FILLED':'PARTIALLY_FILLED',orderId:'FIXTURE-'+tradeId,executedQty:step.qty,quoteQty:step.quote,deltaFeeQuote:step.fee??'0',raw:{paper:true,fixture:FIXTURE_LABEL}},order);
  return store.db.prepare('SELECT * FROM signals WHERE id=?').get(row.id);
}

/** A second database handle on the same database (its own pool), for a concurrent writer. */
export function openSecond(fixture){
  const target=new URL(process.env.TEST_DATABASE_URL);target.pathname='/'+fixture.name;
  const db=new PostgresDatabase({connectionString:target.toString(),max:3});
  return {db,store:new Store(db),close:()=>db.close()};
}
