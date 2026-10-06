import test from 'node:test';
import assert from 'node:assert/strict';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {accountOverview} from '../../src/postgres/overview.js';
import {config} from '../../src/config.js';

// GET /api/overview over the actual application, auth and SERIALIZABLE response buffering. Isolated local PostgreSQL only.
// Read-only endpoint: the case compares whole-table digests before and after the requests. The proxy is off.
const PATH='/api/overview';
async function fixture(t){
  assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
  const f=await quantPreflightHttpFixture(process.env.TEST_DATABASE_URL,{mode:'disabled',environment:{MARKET_PUBLIC_PROXY:'0'}});
  t.after(()=>f.close());return f;
}
const TABLES=['ledger_positions','risk_profiles','paper_funding','paper_snapshots','bot_sessions','audit','users','system_settings'];
async function digests(db){
  const out={};
  for(const table of TABLES){
    const present=(await db.query('SELECT to_regclass($1) AS name',['public.'+table])).rows[0].name;
    const where=table==='audit'?" WHERE x.event<>'request.error'":'';
    out[table]=present?(await db.query(`SELECT md5(COALESCE(string_agg(x::text,'|' ORDER BY x::text),'')) AS d FROM ${table} x${where}`)).rows[0].d:null;
  }
  return out;
}
async function position(db,{user,symbol,quantity,avg}){
  await db.query(`INSERT INTO ledger_positions(user_id,account_id,execution_mode,broker,symbol,quantity,avg_price,stop_loss,take_profit,cost_basis,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[user,'paper-account','PAPER','binance-global',symbol,quantity,avg,null,null,String(Number(quantity)*Number(avg)),1700000000000]);
}

test('overview: own two bots only, 304 on a matching ETag, bot_id and user_id ignored, read-only transaction, nothing written',async t=>{
  const f=await fixture(t),owner=await f.login(f.owner);
  const a=f.owner.id,b=f.sibling.id,c=f.foreign.id;
  await f.db.query('UPDATE users SET label=$2 WHERE id=$1',[a,'Bot A']);
  await position(f.db,{user:a,symbol:'ETHUSDT',quantity:'1',avg:'2000'});
  await position(f.db,{user:b,symbol:'BTCUSDT',quantity:'0.5',avg:'60000'});
  await position(f.db,{user:c,symbol:'ETHUSDT',quantity:'9',avg:'1900'});
  assert.equal((await f.request(PATH)).status,401);
  const before=await digests(f.db);
  const full=await f.request(PATH+'?bot_id=all','GET',undefined,owner);
  assert.equal(full.status,200,JSON.stringify(full.body));
  assert.deepEqual(Object.keys(full.body),['moneyFormat','globalKill','bots','positions']);
  assert.equal(full.body.moneyFormat,'decimal-string');assert.equal(full.body.globalKill,false);
  assert.deepEqual(full.body.bots.map(bot=>bot.id),[a,b],'the account and its one extra bot, in slot order');
  assert.equal(full.body.bots[0].label,'Bot A');
  for(const bot of full.body.bots){
    assert.equal(bot.risk.paperTrading,true);
    assert.equal(bot.paperAccounts.length,4);assert.ok(bot.paperAccounts.every(row=>row.bot_id===bot.id));
    assert.ok(bot.dailyAccounts.every(row=>row.bot_id===bot.id));
    assert.equal(typeof bot.daily.trades,'number');assert.ok(['SETUP','RUNNING','PAUSED','STOPPED'].includes(bot.botSession.state));
  }
  assert.deepEqual(full.body.positions.map(row=>[row.bot_id,row.symbol]),[[a,'ETHUSDT'],[b,'BTCUSDT']]);
  assert.ok(!JSON.stringify(full.body).includes(c),'a foreign account never appears');
  const tag=full.headers.get('etag');
  assert.match(tag,/^"[0-9a-f]{32}"$/);assert.equal(full.headers.get('cache-control'),'no-store');
  // The shared client parses JSON and a 304 has no body, so this request is sent by hand with the same session cookie.
  const cookie=Object.entries(owner.cookie).map(([key,value])=>`${key}=${value}`).join('; ');
  const same=await fetch(f.base+PATH,{headers:{cookie,'if-none-match':tag}});
  assert.equal(same.status,304);assert.equal(await same.text(),'');assert.equal(same.headers.get('etag'),tag);
  const scoped=await f.request(PATH+'?bot_id='+c+'&user_id='+c,'GET',undefined,owner);
  assert.equal(scoped.status,200);assert.deepEqual(scoped.body.bots.map(bot=>bot.id),[a,b]);assert.equal(scoped.headers.get('etag'),tag);
  assert.deepEqual(await digests(f.db),before,'no request wrote to the tables');
  // The same read path inside a SERIALIZABLE transaction that already ran a query, as in the request pipeline:
  // the overview turns it READ ONLY, so a later write in that transaction fails with 25006.
  await assert.rejects(f.db.transaction(async()=>{
    await f.db.query('SELECT 1');
    const body=await accountOverview(f.store,a,config.defaultRisk);
    assert.deepEqual(body.bots.map(bot=>bot.id),[a,b]);
    await f.db.query('UPDATE users SET label=label WHERE id=$1',[a]);
  },{isolation:'SERIALIZABLE'}),error=>error.code==='25006');
  assert.deepEqual(await digests(f.db),before);
});