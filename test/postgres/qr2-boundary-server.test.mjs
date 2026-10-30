import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {quantPreflightHttpFixture} from '../helpers/quant-preflight-http-fixture.mjs';
import {createBot,book,insertBars,barOf} from '../helpers/qr2-reader-fixture.mjs';
import {hashPassword} from '../../src/security.js';
import {QR2_BOUNDARY_RECORD_DEFAULT} from '../../src/portfolio/qr2-boundary-records.js';
import {validateResponse} from '../../src/portfolio/qr2-labels.js';
import {validateOwnerResponse} from '../../src/portfolio/qr2-owner-response.js';

// QR-2 boundary record at server level (contract 6.2; RC-Q46; design test P4). Actual server.js, auth, SERIALIZABLE dispatcher and the real worker
// pool; no environment key selects a record. The shipped staging record ends with an open E2 row, so a fill booked now is E2: both QR-2 routes reconcile
// OK through the registry default alone. This proves server.js passes no boundaries of its own to either route (a server that passed UNRECORDED, or
// dropped the default, would give RECONCILIATION_FAILED here) and that the default reaches the real worker.
// Isolated local PostgreSQL only (TEST_DATABASE_URL). Every fixture row comes through the live Store; nothing here is evidence.

test('P4 actual server: the registry default record makes a fill booked now reconcile on both QR-2 routes',{timeout:60000},async()=>{
  const connection=process.env.TEST_DATABASE_URL;
  assert.ok(connection,'Root-assigned isolated PostgreSQL required');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(connection).hostname),'Loopback fixture only');
  const lastEpoch=QR2_BOUNDARY_RECORD_DEFAULT.epochs.at(-1);
  assert.equal(lastEpoch.epoch,'E2');assert.equal(lastEpoch.to,null,'the last epoch is open');
  assert.ok(Date.now()>=lastEpoch.from,'a fill booked now falls in the open last epoch');
  let f;
  try{
    f=await quantPreflightHttpFixture(connection,{mode:'disabled',environment:{QR2_PERFORMANCE_ENABLED:'1',MARKET_PUBLIC_PROXY:'0'}});
    await f.db.query(await fs.readFile(new URL('../../src/postgres/paper-capital-model.sql',import.meta.url),'utf8'));
    const password='Qr2-boundary-'+randomUUID();
    const owner=await f.store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword(password),role:'USER'});
    const traded=await createBot(f.store,owner,10000),funded=await createBot(f.store,owner,5000);
    const priceNow=async()=>{await f.db.query('DELETE FROM public.pine_market_bars');await insertBars(f.db,[barOf(Math.floor((Date.now()-1000)/60000)*60000,'62000')]);};
    await priceNow();
    await book(f.store,traded,'p4-buy-'+traded.id.slice(0,6),{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
    await priceNow();
    const login=await f.request('/api/auth/login','POST',{email:owner.email,password});
    assert.equal(login.status,200,'real application login');

    const account=await f.request('/api/paper-performance?bot_id='+traded.id+'&period=DAY','GET',undefined,login.session);
    assert.equal(account.status,200,JSON.stringify(account.body));
    assert.equal(account.body.reconciliation.state,'OK',JSON.stringify(account.body.reconciliation));
    assert.equal(account.body.reconciliation.first_failure,null);
    assert.notEqual(account.body.status.status,'UNAVAILABLE');assert.notEqual(account.body.account.nav.value,null);
    assert.equal(validateResponse(account.body).ok,true);

    const ownerRead=await f.request('/api/paper-performance/owner?currency=USDT&period=DAY','GET',undefined,login.session);
    assert.equal(ownerRead.status,200,JSON.stringify(ownerRead.body));
    assert.equal(validateOwnerResponse(ownerRead.body),true);
    const memberOf=bot=>ownerRead.body.accounts.find(row=>row.bot_id===bot.id&&row.broker==='binance-global');
    assert.notEqual(memberOf(traded).status.status,'UNAVAILABLE');assert.notEqual(memberOf(traded).nav_to.value,null);
    assert.notEqual(memberOf(funded).nav_to.value,null);
  }finally{await f?.close();}
});
