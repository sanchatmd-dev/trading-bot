import test from 'node:test';
import assert from 'node:assert/strict';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {ReadinessService} from '../../src/postgres/pf3-readiness-service.js';
import {Money,exact} from '../../src/money.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {config} from '../../src/config.js';

// Stored OHLCV endpoint and the PF-3 market-data item over the actual application, auth and SERIALIZABLE response buffering.
// Isolated local PostgreSQL only. The endpoint reads rows the market-data writer stored; no Binance call exists in this path.
const PATH='/api/market/ohlcv',REPORT='/api/risk/readiness-report',MINUTE=60000,HOUR=60*MINUTE;
const INTERVAL_MS={'1m':MINUTE,'5m':5*MINUTE,'15m':15*MINUTE,'1h':HOUR,'4h':4*HOUR,'1d':24*HOUR};
async function fixture(t){
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  const f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'disabled'});t.after(()=>f.close());return f;
}
// Whole-table digests: any insert, update or delete changes the digest. request.error audit rows (written when a request is refused) are left out.
const TABLES=['pine_market_bars','risk_profiles','paper_funding','paper_snapshots','ledger_positions','signals','bot_sessions','audit','users','system_settings'];
async function digests(db){
  const out={};
  for(const table of TABLES){
    const present=(await db.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name;
    const where=table==='audit'?" WHERE x.event<>'request.error'":'';
    out[table]=present?(await db.query(`SELECT md5(COALESCE(string_agg(x::text,'|' ORDER BY x::text),'')) AS d FROM ${table} x${where}`)).rows[0].d:null;
  }
  return out;
}
// Deterministic synthetic bars on the minute grid: row i opens at start+i*MINUTE and is stored with bar_time = its close time + 1.
const priceOf=index=>{
  const open=new Money(60000).plus(index%97).plus((index%100)/100);
  return {open:open.toFixed(8),high:open.plus((index%7+1)/4).toFixed(8),low:open.minus((index%5+1)/4).toFixed(8),
    close:open.plus(((index%11)-5)/10).toFixed(8),volume:new Money((index%13)+1).div(8).toFixed(8)};
};
async function seed(db,{start,count,gapFirst,gapRows=7}){
  const times=[],bars=[],hashes=[],provenance=JSON.stringify({profile:'closed-ohlcv-atr14-v1',source:'synthetic fixture'});
  for(let index=0;index<count;index++){
    if(index>=gapFirst&&index<gapFirst+gapRows)continue;
    const time=start+(index+1)*MINUTE,bar={time,...priceOf(index),atr14:'2',price_tick:'0.01',quantity_step:'0.001'};
    times.push(time);bars.push(JSON.stringify(bar));hashes.push(hash(canonical(bar)));
  }
  await db.query("INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',x.t,x.b::jsonb,$1::jsonb,x.h FROM unnest($2::bigint[],$3::text[],$4::text[]) AS x(t,b,h)",
    [provenance,times,bars,hashes]);
  return times.map((time,at)=>({time,...JSON.parse(bars[at])}));
}
// Reference aggregation of the same rows with decimal.js: epoch aligned buckets of closed candles only.
function reference(rows,interval,limit){
  const ms=INTERVAL_MS[interval],latest=rows.at(-1).time,end=Math.floor(latest/ms)*ms,begin=end-limit*ms,buckets=new Map();
  for(const row of rows.filter(item=>item.time>begin&&item.time<=end)){
    const key=Math.floor((row.time-MINUTE)/ms)*ms;
    if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(row);
  }
  return [...buckets].sort((a,b)=>a[0]-b[0]).map(([time,list])=>({time,open:exact(list[0].open),
    high:exact(list.reduce((best,row)=>Money.max(best,row.high),new Money(list[0].high)).toFixed()),
    low:exact(list.reduce((best,row)=>Money.min(best,row.low),new Money(list[0].low)).toFixed()),
    close:exact(list.at(-1).close),volume:exact(list.reduce((sum,row)=>sum.plus(row.volume),new Money(0)).toFixed()),
    minutes:list.length,complete:list.length===ms/MINUTE}));
}

async function seeded(t){
  const f=await fixture(t),owner=await f.login(f.owner);
  const end=Math.floor(Date.now()/MINUTE)*MINUTE-MINUTE,start=Math.floor((end-48*HOUR)/HOUR)*HOUR,count=(end-start)/MINUTE;
  // The 7 missing minutes sit inside the last day, away from every hour boundary (bar_time offsets 31..37 minutes past an hour).
  const gapFirst=Math.floor((count-300)/60)*60+30;
  const rows=await seed(f.db,{start,count,gapFirst});
  return {f,owner,rows,start,end,gap:{from_open_time:start+gapFirst*MINUTE,to_open_time:start+(gapFirst+6)*MINUTE,missing_minutes:7}};
}
const get=(f,session,query='')=>f.request(PATH+query,'GET',undefined,session);

test('auth and query validation: 401 without a session, strict keys, interval allow-list, limit bounds, GET only',async t=>{
  const {f,owner}=await seeded(t);
  assert.equal((await f.request(PATH)).status,401);
  const before=await digests(f.db);
  assert.equal((await get(f,owner)).status,200);
  assert.equal((await get(f,owner,'?bot_id='+f.owner.id+'&interval=1h')).status,200,'the shared api() helper appends bot_id');
  assert.equal((await get(f,owner,'?bot_id=all')).status,200);
  const refused=[['?interval=2h',400,'INTERVAL_NOT_ALLOWED'],['?limit=0',400,'LIMIT_OUT_OF_RANGE'],['?interval=4h&limit=181',400,'LIMIT_OUT_OF_RANGE'],
    ['?interval=1d&limit=31',400,'LIMIT_OUT_OF_RANGE'],['?interval=1h&limit=721',400,'LIMIT_OUT_OF_RANGE'],['?limit=abc',400,'LIMIT_OUT_OF_RANGE'],
    ['?foo=1',400,'INVALID_FIELDS'],['?interval=1h&interval=5m',400,'INVALID_FIELDS'],['?limit=',400,'INVALID_FIELDS']];
  for(const [query,status,code] of refused){
    const answer=await get(f,owner,query);
    assert.equal(answer.status,status,query);assert.equal(answer.body.code,code,query);
  }
  assert.equal((await f.request(PATH,'POST',{},owner)).status,405);
  assert.deepEqual(await digests(f.db),before,'no request wrote to the tables');
});

test('1m answer: exact normalized strings, closed bars only, metadata and no internal fields',async t=>{
  const {f,owner,rows,end}=await seeded(t);
  const answer=await get(f,owner,'?interval=1m&limit=5');
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const body=answer.body,last=rows.slice(-5);
  assert.equal(body.version,'market-ohlcv-v1');assert.equal(body.source,'binance-spot-public-stored');assert.equal(body.status,'OK');
  assert.deepEqual([body.broker,body.symbol,body.market,body.base_timeframe,body.closed_only],['binance-global','BTCUSDT','SPOT','1m',true]);
  assert.equal(body.latest_closed_bar.close_time,end);assert.equal(body.latest_closed_bar.open_time,end-MINUTE);
  assert.ok(body.age_seconds>=60&&body.age_seconds<600,'age '+body.age_seconds);
  assert.deepEqual(body.bars.map(bar=>bar.time),last.map(row=>row.time-MINUTE));
  for(const [at,bar] of body.bars.entries()){
    assert.equal(bar.open,exact(last[at].open));assert.equal(bar.close,exact(last[at].close));assert.equal(bar.volume,exact(last[at].volume));
    assert.equal(bar.minutes,1);assert.equal(bar.complete,true);assert.ok(!bar.open.endsWith('0')||!bar.open.includes('.'),'trailing zeros removed');
  }
  const text=JSON.stringify(body);
  for(const banned of ['provenance','content_hash','synthetic fixture','http'])assert.ok(!text.includes(banned),banned);
});

test('15m, 1h, 4h and 1d equal a decimal.js reference aggregation of the same stored rows; gap ranges are exact',async t=>{
  const {f,owner,rows,gap}=await seeded(t);
  for(const [interval,limit] of [['5m',100],['15m',100],['1h',48],['4h',12],['1d',2]]){
    const answer=await get(f,owner,`?interval=${interval}&limit=${limit}`);
    assert.equal(answer.status,200,interval+JSON.stringify(answer.body));
    const expected=reference(rows,interval,limit);
    assert.ok(expected.length>0,interval);
    assert.deepEqual(answer.body.bars,expected,interval);
    assert.ok(answer.body.bars.every((bar,at,list)=>at===0||list[at-1].time<bar.time));
    assert.ok(answer.body.bars.at(-1).time+INTERVAL_MS[interval]<=answer.body.latest_closed_bar.close_time,'the forming bucket is never returned: '+interval);
  }
  const hourly=await get(f,owner,'?interval=1h&limit=48');
  assert.equal(hourly.body.gaps.count,1);assert.equal(hourly.body.gaps.missing_minutes,7);assert.deepEqual(hourly.body.gaps.ranges,[gap]);
  assert.equal(hourly.body.bars.filter(bar=>!bar.complete).length,1,'the bucket with the hole is flagged incomplete');
  const minutes=await get(f,owner,'?interval=1m&limit=1000');
  assert.deepEqual(minutes.body.gaps.ranges,[gap]);assert.equal(minutes.body.gaps.truncated,false);
  const quiet=await get(f,owner,'?interval=1m');
  assert.equal(quiet.body.gaps.count,0,'the default 240 minutes do not reach the hole');
});

test('readiness report carries an advisory market_data item; verdict and blockers equal a service without it; nothing is written',async t=>{
  const {f,owner,gap}=await seeded(t);
  await f.store.setRisk(f.owner.id,{...structuredClone(config.defaultRisk),blockDuringNews:false,equities:{'binance-global':'1000'},balances:{'binance-global':'800'}});
  const before=await digests(f.db);
  const answer=await f.request(REPORT,'GET',undefined,owner);
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const {market_data:item,...report}=answer.body;
  assert.equal(item.version,'pf3-market-data-v1');assert.equal(item.advisory,true);assert.equal(item.affects_verdict,false);assert.deepEqual(item.unlocks,[]);
  assert.equal(item.status,'WARN');assert.ok(item.reasons.includes('MARKET_DATA_GAPS'),JSON.stringify(item.reasons));
  assert.equal(item.missing_bars,7);assert.equal(item.gap_count,1);assert.deepEqual(item.gaps,[gap]);assert.equal(item.expected_bars-item.bars_available,7);
  assert.equal(item.source,'binance-spot-public-stored');assert.equal(item.window_minutes,1440);
  const plain=new ReadinessService({store:f.store,defaultRisk:config.defaultRisk,pineBridgeEnabled:true,clock:()=>Date.parse(report.generated_at)});
  const reference=await plain.report(f.owner.id,f.owner.id);
  assert.equal('market_data' in reference,false,'a service without a reader has no market_data');
  assert.equal(report.verdict,reference.verdict);assert.deepEqual(report.verdict_basis,reference.verdict_basis);assert.deepEqual(report.blockers,reference.blockers);
  assert.equal(report.rules_version,reference.rules_version);
  assert.deepEqual(await digests(f.db),before,'the report and the read-only item wrote nothing');
});

test('no stored bars: EMPTY chart answer and a FAIL readiness item, both without an error',async t=>{
  const f=await fixture(t),owner=await f.login(f.owner);
  const answer=await get(f,owner,'?interval=1h');
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  assert.equal(answer.body.status,'EMPTY');assert.equal(answer.body.stale,true);assert.deepEqual(answer.body.bars,[]);assert.equal(answer.body.latest_closed_bar,null);
  const report=await f.request(REPORT,'GET',undefined,owner);
  assert.equal(report.status,200,JSON.stringify(report.body));
  assert.equal(report.body.market_data.status,'FAIL');assert.deepEqual(report.body.market_data.reasons,['MARKET_DATA_EMPTY']);
});
