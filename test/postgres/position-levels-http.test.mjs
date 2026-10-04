import test from 'node:test';
import assert from 'node:assert/strict';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';

// GET /api/positions/levels over the actual application, auth and SERIALIZABLE response buffering. Isolated local PostgreSQL only.
// Read-only endpoint: every case compares whole-table digests before and after the requests. Rows are seeded straight into the ledger
// tables; the proxy is off (MARKET_PUBLIC_PROXY=0), so no network exists in this file.
const PATH='/api/positions/levels',BROKER='binance-global',ACCOUNT='paper-account',MODE='PAPER';
async function fixture(t){
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  const f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'disabled',environment:{MARKET_PUBLIC_PROXY:'0'}});
  t.after(()=>f.close());return f;
}
const TABLES=['ledger_positions','ledger_position_allocations','signals','risk_profiles','paper_funding','paper_snapshots','bot_sessions','audit','users','system_settings'];
async function digests(db){
  const out={};
  for(const table of TABLES){
    const present=(await db.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name;
    const where=table==='audit'?" WHERE x.event<>'request.error'":'';
    out[table]=present?(await db.query(`SELECT md5(COALESCE(string_agg(x::text,'|' ORDER BY x::text),'')) AS d FROM ${table} x${where}`)).rows[0].d:null;
  }
  return out;
}
let counter=0;
async function position(db,{user,symbol,quantity,avg,stop=null,take=null,broker=BROKER,updated=1700000000000}){
  await db.query(`INSERT INTO ledger_positions(user_id,account_id,execution_mode,broker,symbol,quantity,avg_price,stop_loss,take_profit,cost_basis,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[user,ACCOUNT,MODE,broker,symbol,quantity,avg,stop,take,String(Number(quantity)*Number(avg)),updated]);
}
// One open lot: a signal row for the entry (its fill_price is the executed price) and the allocation that references it.
async function lot(db,{user,symbol,quantity,cost,fill=null,stop=null,take=null,opened,status='OPEN',broker=BROKER}){
  const id=++counter;
  const signal=(await db.query(`INSERT INTO signals(user_id,trade_id,received_at,signal_time,broker,symbol,event,side,payload,status,fill_price,execution_mode,account_id)
    VALUES($1,$2,$3,$3,$4,$5,'ENTRY','BUY','{}','FILLED',$6,$7,$8) RETURNING id`,[user,'lot-'+id,opened,broker,symbol,fill,MODE,ACCOUNT])).rows[0].id;
  await db.query(`INSERT INTO ledger_position_allocations(position_id,user_id,account_id,execution_mode,broker,symbol,entry_signal_id,entry_trade_id,status,
      filled_quantity,remaining_quantity,entry_price,stop_loss,take_profit,opened_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$14)`,
    ['alloc-'+id,user,ACCOUNT,MODE,broker,symbol,signal,'lot-'+id,status,quantity,cost,stop,take,opened]);
  return 'alloc-'+id;
}
async function seeded(t){
  const f=await fixture(t),owner=await f.login(f.owner);
  const a=f.owner.id,b=f.sibling.id,c=f.foreign.id;
  await f.db.query('UPDATE users SET label=$2 WHERE id=$1',[a,'Bot A']);
  await f.db.query('UPDATE users SET label=$2 WHERE id=$1',[b,'Held assets']);
  // Bot A: ETHUSDT with two lots (the position row keeps only the newest levels), a legacy BTCUSDT position without lots and a
  // position at another broker. Bot B: one ETHUSDT lot. The foreign account holds ETHUSDT too and must never appear.
  await position(f.db,{user:a,symbol:'ETHUSDT',quantity:'3',avg:'2003.3',stop:'1950',take:'0',updated:1700000000123});
  const first=await lot(f.db,{user:a,symbol:'ETHUSDT',quantity:'1',cost:'1990',fill:'2000.5',stop:'1900',take:'2100',opened:1700000000000});
  const second=await lot(f.db,{user:a,symbol:'ETHUSDT',quantity:'2',cost:'2005',stop:'1950',take:'0',opened:1700000100000});
  await position(f.db,{user:a,symbol:'BTCUSDT',quantity:'0.5',avg:'60000',stop:'59000',take:'62000'});
  await position(f.db,{user:a,symbol:'BTCTHB',quantity:'1',avg:'2000000',broker:'binance-th'});
  await position(f.db,{user:b,symbol:'ETHUSDT',quantity:'1',avg:'2100',stop:'2000',take:'2300'});
  await lot(f.db,{user:b,symbol:'ETHUSDT',quantity:'1',cost:'2100',fill:'2101',stop:'2000',take:'2300',opened:1700000200000});
  await position(f.db,{user:c,symbol:'ETHUSDT',quantity:'9',avg:'1900'});
  return {f,owner,a,b,c,first,second};
}
const get=(f,session,query='')=>f.request(PATH+query,'GET',undefined,session);
const find=(body,bot,symbol)=>body.positions.find(item=>item.bot_id===bot&&item.symbol===symbol);

test('auth and scope: 401 without a session, 403 for a foreign bot, single-bot scope by default, bot_id=all lists only owned bots; nothing is written',async t=>{
  const {f,owner,a,b,c}=await seeded(t);
  assert.equal((await f.request(PATH)).status,401);
  const before=await digests(f.db);
  const own=await get(f,owner);
  assert.equal(own.status,200,JSON.stringify(own.body));
  assert.equal(own.body.version,'position-levels-v1');assert.equal(own.body.scope,'bot');assert.equal(own.body.truncated,false);
  assert.ok(Number.isFinite(Date.parse(own.body.generated_at)));
  assert.deepEqual(own.body.positions.map(item=>item.symbol).sort(),['BTCTHB','BTCUSDT','ETHUSDT']);
  assert.ok(own.body.positions.every(item=>item.bot_id===a&&item.bot_label==='Bot A'));
  const second=await get(f,owner,'?bot_id='+b);
  assert.equal(second.status,200);assert.equal(second.body.scope,'bot');assert.deepEqual(second.body.positions.map(item=>item.bot_id),[b]);
  const all=await get(f,owner,'?bot_id=all');
  assert.equal(all.status,200,JSON.stringify(all.body));assert.equal(all.body.scope,'all');
  assert.equal(all.body.positions.length,4);assert.ok(all.body.positions.every(item=>item.bot_id===a||item.bot_id===b));
  assert.equal(all.body.positions.some(item=>item.bot_id===c),false,'a foreign account position never appears');
  assert.equal(find(all.body,b,'ETHUSDT').bot_label,'Held assets');
  const foreign=await get(f,owner,'?bot_id='+c);
  assert.equal(foreign.status,403);
  assert.deepEqual(await digests(f.db),before,'no request wrote to the tables');
});

test('per-lot shaping: two ETHUSDT lots with fill or cost entry, null and zero levels, legacy position, other broker, no internal ids',async t=>{
  const {f,owner,a,b}=await seeded(t);
  const answer=await get(f,owner,'?bot_id=all');
  assert.equal(answer.status,200,JSON.stringify(answer.body));
  const eth=find(answer.body,a,'ETHUSDT');
  assert.deepEqual([eth.broker,eth.chart_symbol,eth.execution_mode,eth.side],[BROKER,'ETHUSDT',MODE,'LONG']);
  assert.deepEqual([eth.quantity,eth.avg_price,eth.stop_loss,eth.take_profit],['3','2003.3','1950',null],'zero take profit means not set');
  assert.equal(eth.updated_at,1700000000123);assert.equal(eth.lots_match_position,true);
  assert.deepEqual(eth.lots,[
    {lot:1,opened_at:1700000000000,quantity:'1',entry_price:'2000.5',entry_basis:'fill',stop_loss:'1900',take_profit:'2100'},
    {lot:2,opened_at:1700000100000,quantity:'2',entry_price:'2005',entry_basis:'cost',stop_loss:'1950',take_profit:null}]);
  const legacy=find(answer.body,a,'BTCUSDT');
  assert.deepEqual(legacy.lots,[]);assert.equal(legacy.lots_match_position,true);
  assert.deepEqual([legacy.quantity,legacy.avg_price,legacy.stop_loss,legacy.take_profit],['0.5','60000','59000','62000']);
  assert.equal(find(answer.body,a,'BTCTHB').chart_symbol,null,'only binance-global positions get a chart symbol');
  const other=find(answer.body,b,'ETHUSDT');
  assert.equal(other.lots.length,1);assert.equal(other.lots[0].lot,1);assert.equal(other.lots[0].entry_price,'2101');assert.equal(other.lots[0].entry_basis,'fill');
  const text=JSON.stringify(answer.body);
  for(const banned of ['position_id','entry_signal_id','entry_trade_id','alloc-','lot-','account_id',ACCOUNT])assert.ok(!text.includes(banned),banned);
});

test('a closed lot disappears, a lot sum below the position row is flagged, and a flat position disappears',async t=>{
  const {f,owner,a,b,second}=await seeded(t);
  assert.equal(find((await get(f,owner)).body,a,'ETHUSDT').lots.length,2);
  await f.db.query("UPDATE ledger_position_allocations SET status='CLOSED',remaining_quantity=0,closed_at=1700000300000,updated_at=1700000300000 WHERE position_id=$1",[second]);
  const mismatch=find((await get(f,owner)).body,a,'ETHUSDT');
  assert.equal(mismatch.lots.length,1);assert.deepEqual(mismatch.lots.map(item=>item.lot),[1]);
  assert.equal(mismatch.lots_match_position,false,'one open lot of 1 against a position of 3');
  await f.db.query("UPDATE ledger_positions SET quantity=1,cost_basis=2000.5 WHERE user_id=$1 AND symbol='ETHUSDT'",[a]);
  assert.equal(find((await get(f,owner)).body,a,'ETHUSDT').lots_match_position,true);
  await f.db.query("UPDATE ledger_positions SET quantity=0,cost_basis=0 WHERE user_id=$1 AND symbol='ETHUSDT'",[a]);
  const flat=await get(f,owner);
  assert.equal(find(flat.body,a,'ETHUSDT'),undefined,'a closed position has no lines');
  const before=await digests(f.db);
  assert.equal((await get(f,owner,'?bot_id=all')).status,200);
  assert.deepEqual(await digests(f.db),before,'reads wrote nothing');
  assert.equal(find((await get(f,owner,'?bot_id='+b)).body,b,'ETHUSDT').lots.length,1,'the other bot is unaffected');
});