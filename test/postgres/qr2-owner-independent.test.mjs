import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createQr2Database,createOwner,openSecond,LOCAL_FIXTURE_E2} from '../helpers/qr2-reader-fixture.mjs';
import {readQr2OwnerSnapshot} from '../../src/postgres/qr2-owner-reader.js';
import {writeQr2Audit,QR2_AUDIT_EVENT} from '../../src/postgres/qr2-audit.js';
const DAY=86400000;
const install=f=>fs.readFile(new URL('../../src/postgres/paper-capital-model.sql',import.meta.url),'utf8').then(sql=>f.db.query(sql));
const position=(db,owner,symbol,at)=>db.query("INSERT INTO ledger_positions(user_id,account_id,execution_mode,broker,symbol,quantity,updated_at) VALUES($1,'binance-global:primary','PAPER','binance-global',$2,1,$3)",[owner,symbol,at]);

test('independent PostgreSQL position and exposure rows count twice at exact whole-owner cap and one over',async()=>{
  const f=await createQr2Database('robot_qr2_independent_positions');
  try{
    await install(f);const owner=await createOwner(f.store),from=Math.floor(Date.now()/DAY)*DAY-DAY,to=from+DAY;
    await f.db.query('UPDATE users SET created_at=$2 WHERE id=$1',[owner.id,from-1]);
    for(const symbol of ['BTCUSDT','ETHUSDT','SOLUSDT'])await position(f.db,owner.id,symbol,from);
    const args={ownerId:owner.id,currency:'USDT',from,to,requestTime:to,boundaries:LOCAL_FIXTURE_E2};
    const exact=await readQr2OwnerSnapshot(f.store,{...args,limits:{ledger_rows:6}});
    assert.equal(exact.snapshot.counts.ledger_rows,6);assert.equal(exact.snapshot.accounts.length,1);assert.equal(exact.snapshot.accounts[0].snapshot.positions.length,3);
    const query=f.db.query.bind(f.db);let details=0;
    f.db.query=async(sql,...rest)=>{if(sql.startsWith('SELECT user_id,account_id,execution_mode,broker,symbol,quantity'))details++;return query(sql,...rest);};
    try{await assert.rejects(readQr2OwnerSnapshot(f.store,{...args,limits:{ledger_rows:5}}),e=>e.code==='QR2_RANGE_ADMISSION_REFUSED'&&e.detail.limit==='ledger_rows'&&e.detail.value===6&&e.detail.max===5);assert.equal(details,0);}finally{f.db.query=query;}
  }finally{await f.dispose();}
});

test('independent PostgreSQL concurrent position insert cannot split owner admission counts from member materialization',async()=>{
  const f=await createQr2Database('robot_qr2_independent_atomic');let second;
  try{
    await install(f);second=openSecond(f);const owner=await createOwner(f.store),from=Math.floor(Date.now()/DAY)*DAY-DAY,to=from+DAY;
    await f.db.query('UPDATE users SET created_at=$2 WHERE id=$1',[owner.id,from-1]);await position(f.db,owner.id,'BTCUSDT',from);
    const args={ownerId:owner.id,currency:'USDT',from,to,requestTime:to,boundaries:LOCAL_FIXTURE_E2};
    const query=f.db.query.bind(f.db);let inserted=false;
    f.db.query=async(sql,...rest)=>{const answer=await query(sql,...rest);if(!inserted&&sql.includes('SELECT count(*) AS n FROM public.ledger_positions WHERE user_id=$1 AND broker=$2')){inserted=true;await position(second.db,owner.id,'ETHUSDT',from);}return answer;};
    let stable;try{stable=await readQr2OwnerSnapshot(f.store,{...args,limits:{ledger_rows:2}});}finally{f.db.query=query;}
    assert.equal(inserted,true);assert.equal(stable.snapshot.counts.ledger_rows,2);assert.equal(stable.snapshot.accounts[0].snapshot.positions.length,1);
    await assert.rejects(readQr2OwnerSnapshot(f.store,{...args,limits:{ledger_rows:3}}),e=>e.code==='QR2_RANGE_ADMISSION_REFUSED'&&e.detail.value===4&&e.detail.max===3);
    const fresh=await readQr2OwnerSnapshot(f.store,{...args,limits:{ledger_rows:4}});assert.equal(fresh.snapshot.counts.ledger_rows,4);assert.equal(fresh.snapshot.accounts[0].snapshot.positions.length,2);
  }finally{await second?.close();await f.dispose();}
});

test('independent PostgreSQL owner audit identity includes broker and stays deduplicated outside the read snapshot',async()=>{
  const f=await createQr2Database('robot_qr2_independent_audit');
  try{
    const owner=await createOwner(f.store),finding={check:'R3',code:'RECONCILIATION_FAILED',event_key:'synthetic-shared-event'};
    await f.db.transaction(async()=>{await assert.rejects(writeQr2Audit(f.store,{botId:owner.id,broker:'binance-th',findings:[finding]}),{code:'QR2_AUDIT_OUTSIDE_TRANSACTION_REQUIRED'});},{isolation:'REPEATABLE READ'});
    assert.equal((await writeQr2Audit(f.store,{botId:owner.id,broker:'binance-th',findings:[finding]})).written,1);
    assert.equal((await writeQr2Audit(f.store,{botId:owner.id,broker:'settrade',findings:[finding]})).written,1);
    assert.equal((await writeQr2Audit(f.store,{botId:owner.id,broker:'binance-th',findings:[finding]})).written,0);
    const rows=(await f.db.query('SELECT trade_id,details FROM audit WHERE user_id=$1 AND event=$2',[owner.id,QR2_AUDIT_EVENT])).rows;
    assert.equal(rows.length,2);assert.equal(new Set(rows.map(row=>row.trade_id)).size,2);assert.deepEqual(rows.map(row=>JSON.parse(row.details).broker).sort(),['binance-th','settrade']);
  }finally{await f.dispose();}
});
