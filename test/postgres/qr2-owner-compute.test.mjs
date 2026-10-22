import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createQr2Database,createOwner,createBot,book,insertBars,barOf,LOCAL_FIXTURE_E2,ledgerDigest} from '../helpers/qr2-reader-fixture.mjs';
import {appendCapitalModelDeclaration} from '../../src/postgres/qr2-capital-model-route.js';
import {readQr2OwnerSnapshot} from '../../src/postgres/qr2-owner-reader.js';
import {createQr2ComputePool} from '../../src/postgres/qr2-compute-pool.js';
import {validateOwnerResponse} from '../../src/portfolio/qr2-owner-response.js';

test('owner actual worker sums two live-funded cash accounts from one PostgreSQL snapshot',async()=>{
  const f=await createQr2Database('robot_qr2_owner_compute');
  const pool=createQr2ComputePool();
  try{
    await f.db.query(await fs.readFile(new URL('../../src/postgres/paper-capital-model.sql',import.meta.url),'utf8'));
    const owner=await createOwner(f.store),a=await createBot(f.store,owner,600),b=await createBot(f.store,owner,400);
    const declaration=await f.db.transaction(()=>appendCapitalModelDeclaration(f.store,{ownerId:owner.id,currency:'USDT',capitalModel:'INDEPENDENT_ACCOUNTS'}),{isolation:'SERIALIZABLE'});
    // Simulate a future reporting clock after the real declaration becomes effective. No database clock or guard is changed.
    const from=declaration.effective_from,to=from+86400000;
    const before=[await ledgerDigest(f.db,a),await ledgerDigest(f.db,b)];
    const read=await readQr2OwnerSnapshot(f.store,{ownerId:owner.id,currency:'USDT',from,to,requestTime:to,boundaries:LOCAL_FIXTURE_E2});
    const result=await pool.run(read.snapshot,read.input);
    assert.equal(result.ok,true,JSON.stringify(result));
    const body=result.body;
    assert.equal(validateOwnerResponse(body),true);
    assert.equal(body.allocation.capital_model,'INDEPENDENT_ACCOUNTS');
    assert.equal(body.total.label,'SUM_OF_INDEPENDENT_PAPER_ACCOUNTS');
    assert.equal(body.total.member_count,2);
    assert.equal(body.total.nav_from.value,'1000');assert.equal(body.total.nav_to.value,'1000');
    assert.equal(body.total.flows_total.value,'0');assert.equal(body.total.fees.value,'0');assert.equal(body.total.money_pnl.value,'0');
    assert.equal(body.total.twr.value,null);assert.equal(body.total.mwr.value,null);
    assert.equal(body.accounts.find(x=>x.bot_id===owner.id).account,'NO_ACCOUNT');
    assert.equal(body.first_funding_at,Math.min(...read.snapshot.accounts.map(x=>x.snapshot.fundings[0].at)));
    assert.equal(result.auditFindings.length,0);assert.equal(pool.counters.completed,1);
    assert.deepEqual([await ledgerDigest(f.db,a),await ledgerDigest(f.db,b)],before);
    // The real worker rejects a mismatched owner discriminator; no fallback to an account computation is allowed.
    assert.deepEqual(await pool.run(read.snapshot,{...read.input,kind:'account'}),{ok:false,kind:'other'});
  }finally{await pool.close();await f.dispose();}
});

test('owner actual worker preserves two accounts nonzero fees and positive/negative PnL without an eligible owner declaration',{timeout:45000},async()=>{
  const f=await createQr2Database('robot_qr2_owner_values');
  const pool=createQr2ComputePool();
  // Observe the natural clock only: no reporting, database or guard clock overrides.
  const after=async instant=>{
    const deadline=Date.now()+5000;
    while(Date.now()<=instant){assert.ok(Date.now()<deadline,'natural clock advances within fixture budget');await delay(1);}
    return Date.now();
  };
  try{
    await f.db.query(await fs.readFile(new URL('../../src/postgres/paper-capital-model.sql',import.meta.url),'utf8'));
    const owner=await createOwner(f.store),a=await createBot(f.store,owner,1000),b=await createBot(f.store,owner,2000);
    const fundingAt=Number((await f.db.query('SELECT max(at) AS at FROM public.paper_funding WHERE user_id=ANY($1::text[])',[[a.id,b.id]])).rows[0].at);
    assert.ok(Number.isSafeInteger(fundingAt));
    const from=await after(fundingAt);
    assert.ok(from>fundingAt,'both initial funding events precede the report range');
    await after(from);
    // Synthetic prior closed bar supports intermediate open-position valuation only.
    await insertBars(f.db,[barOf(Math.floor(from/60000)*60000-60000,'60000')]);
    // A: 1000 - 600 - 0.6 + 660 - 0.66 = 1058.74; fees 1.26; PnL +58.74.
    await book(f.store,a,'owner-values-a-buy',{side:'BUY',steps:[{qty:'0.01',quote:'600',fee:'0.6'}]});
    await book(f.store,a,'owner-values-a-sell',{side:'SELL',steps:[{qty:'0.01',quote:'660',fee:'0.66'}]});
    // B: 2000 - 600 - 0.6 + 570 - 0.57 = 1968.83; fees 1.17; PnL -31.17.
    await book(f.store,b,'owner-values-b-buy',{side:'BUY',steps:[{qty:'0.01',quote:'600',fee:'0.6'}]});
    await book(f.store,b,'owner-values-b-sell',{side:'SELL',steps:[{qty:'0.01',quote:'570',fee:'0.57'}]});
    const fills=(await f.db.query(`SELECT f.received_at FROM public.fills f JOIN public.signals s ON s.id=f.signal_id
      WHERE s.user_id=ANY($1::text[]) ORDER BY f.received_at`,[[a.id,b.id]])).rows;
    assert.equal(fills.length,4);
    assert.ok(fills.every(row=>Number(row.received_at)>from),'all four fee-bearing fills follow the start');
    const to=await after(Math.max(...fills.map(row=>Number(row.received_at))));
    assert.ok(fills.every(row=>Number(row.received_at)<to),'all four fills precede the exclusive end');
    const before=[await ledgerDigest(f.db,owner),await ledgerDigest(f.db,a),await ledgerDigest(f.db,b)];
    const read=await readQr2OwnerSnapshot(f.store,{ownerId:owner.id,currency:'USDT',from,to,requestTime:to,boundaries:LOCAL_FIXTURE_E2});
    assert.deepEqual(read.snapshot.declarations,[],'no next-midnight declaration is manufactured');
    const result=await pool.run(read.snapshot,read.input);
    assert.equal(result.ok,true);
    const body=result.body;
    assert.equal(validateOwnerResponse(body),true);
    assert.equal(body.allocation.capital_model,null);
    assert.equal(body.allocation.reason,'CAPITAL_MODEL_NOT_DECLARED');
    assert.equal(body.total.label,null);
    assert.equal(body.total.member_count,0);
    for(const field of ['nav_from','nav_to','flows_total','fees','money_pnl','twr','mwr']){
      assert.equal(body.total[field].value,null,field+' is unavailable without an applicable declaration');
      assert.ok(body.total[field].reasons.includes('CAPITAL_MODEL_NOT_DECLARED'));
    }
    for(const [bot,initial,final,fees,pnl] of [[a,'1000','1058.74','1.26','58.74'],[b,'2000','1968.83','1.17','-31.17']]){
      const account=body.accounts.find(row=>row.bot_id===bot.id&&row.broker==='binance-global');
      assert.ok(account,'the actual owner worker returns each funded account');
      assert.equal(account.nav_from.value,initial);
      assert.equal(account.nav_to.value,final);
      assert.equal(account.flows_total.value,'0');
      assert.equal(account.fees.value,fees);
      assert.equal(account.money_pnl.value,pnl);
    }
    assert.equal(result.auditFindings.length,0);
    assert.equal(pool.counters.completed,1);
    assert.deepEqual([await ledgerDigest(f.db,owner),await ledgerDigest(f.db,a),await ledgerDigest(f.db,b)],before,'owner reader and worker leave ledger, audit and fences unchanged');
  }finally{try{await pool.close();}finally{await f.dispose();}}
});
