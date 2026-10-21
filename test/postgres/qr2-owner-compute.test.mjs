import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createQr2Database,createOwner,createBot,LOCAL_FIXTURE_E2,ledgerDigest} from '../helpers/qr2-reader-fixture.mjs';
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
