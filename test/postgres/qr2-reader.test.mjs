import test from 'node:test';
import {before,after} from '../helpers/root-hook-gate.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {readQr2Account,QR2_READ_LIMITS} from '../../src/postgres/qr2-reader.js';
import {QR2_BOUNDARY_RECORD_UNRECORDED,validateBoundaryRecord} from '../../src/portfolio/qr2-boundaries.js';
import {rangePerformance} from '../../src/portfolio/qr2-returns.js';
import {createQr2Database,createOwner,createBot,setCapital,book,insertBars,barOf,ledgerDigest,openSecond,LOCAL_FIXTURE_E2,MINUTE} from '../helpers/qr2-reader-fixture.mjs';

// QR-2 S2 reader (docs/QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md 6.1, 6.6, 8.1 to 8.4; tests T1 to T9). Isolated local PostgreSQL only. The ledger is written by the
// live recordFunding / recordExecution; every direct-SQL write below is a labelled fault or fixture exception made by the test, never by
// the product. Expected values are literals worked out by hand in the comments or read from the tables by independent SQL.
let fx,db,store,owner;
before(async()=>{fx=await createQr2Database();({db,store}=fx);owner=await createOwner(store);});
after(async()=>{await fx?.dispose();});

// Each Bot gets its own owner (an owner holds at most 5 Bot profiles).
const newBot=async capital=>{const o=await createOwner(store);const bot=await createBot(store,o,capital);bot.owner=o;return bot;};
const read=(bot,extra={},who=bot.owner??owner)=>{
  const now=extra.requestTime??Date.now();
  return readQr2Account(store,{ownerId:who.id,botId:bot.id,broker:'binance-global',from:bot.created_at,to:now,requestTime:now,boundaries:LOCAL_FIXTURE_E2,...extra});
};
// Labelled fixture reset: the table holds only the bars of the running test.
async function priceTable(bars){await db.query('DELETE FROM public.pine_market_bars');await insertBars(db,bars);}
// One Bot, BUY 0.01 at 60000 (quote 600) and SELL 0.004 at 61000 (quote 244), no fee. Hand values at a price of 62000: quantity 0.006, cost
// 360, cash 10000 - 600 + 244 = 9644, market value 372, NAV 10016, realized 4, unrealized 12.
async function simple(){
  const now=Date.now();
  await priceTable([barOf(Math.floor((now-1000)/60000)*60000,'62000')]);
  const bot=await newBot(10000);
  const buy=await book(store,bot,'buy-'+bot.id.slice(0,6),{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  const sell=await book(store,bot,'sell-'+bot.id.slice(0,6),{side:'SELL',steps:[{qty:'0.004',quote:'244'}]});
  return {bot,buy,sell};
}
const code=(result,gate)=>result.gates.gates[gate].failures.map(f=>f.code||f.reason);

test('boundary record: validation rules and the fail-closed product default',()=>{
  assert.equal(QR2_BOUNDARY_RECORD_UNRECORDED.record_id,'UNRECORDED');
  assert.deepEqual(validateBoundaryRecord(QR2_BOUNDARY_RECORD_UNRECORDED).epochs,[]);
  const ok={record_id:'R',epochs:[{epoch:'E0',from:null,to:100},{epoch:'E1',from:100,to:200},{epoch:'E2',from:200,to:null}],lot_fee_boundary:150,lot_table_boundary:50,evidence:'docs/evidence/x.json'};
  assert.equal(validateBoundaryRecord(ok).epochs.length,3);
  const refused=(record,pattern)=>assert.throws(()=>validateBoundaryRecord(record),error=>error.code==='QR2_BOUNDARY_RECORD_INVALID'&&pattern.test(error.message));
  refused({...ok,evidence:null},/evidence is required/);
  refused({...ok,record_id:''},/record_id/);
  refused({...ok,epochs:[{epoch:'E2',from:0,to:10},{epoch:'E0',from:10,to:null}]},/ordered/);
  refused({...ok,epochs:[{epoch:'E0',from:0,to:150},{epoch:'E1',from:100,to:null}]},/overlap/);
  refused({...ok,epochs:[{epoch:'E0',from:0,to:null},{epoch:'E1',from:100,to:null}]},/open/);
  refused({...ok,epochs:[{epoch:'E0',from:5,to:5}]},/from < to/);
  refused({...ok,epochs:[{epoch:'E9',from:0,to:5}]},/unknown epoch/);
  refused({...ok,lot_fee_boundary:1.5},/integer/);
  // The evidence is a repository-relative path: a machine location never enters the response.
  for(const bad of ['C:/work/evidence.json','c:\\work\\evidence.json','/home/x/evidence.json','\\\\server\\share\\x.json','docs\\evidence\\x.json','../outside/x.json','docs/../../x.json','..'])refused({...ok,evidence:bad},/repository-relative/);
  assert.equal(validateBoundaryRecord({...ok,evidence:'docs/evidence/a..b/x.json'}).evidence,'docs/evidence/a..b/x.json');
  // Z2 allow-list: only docs/evidence/**.json or a 64-hex digest. Every other form is refused, including the forms a deny-list let through.
  const digest='a'.repeat(32)+'0123456789'.repeat(3)+'ab';
  assert.equal(digest.length,64);
  assert.equal(validateBoundaryRecord({...ok,evidence:digest}).evidence,digest);
  const forms={
    'file URL':'file:///home/u/x.json','tilde':'~/x.json','percent variable':'%LOCALAPPDATA%/x.json','dollar variable':'$HOME/x.json',
    'drive letter':'D:/x/evidence.json','drive letter, no slash':'D:evidence.json','absolute path':'/etc/evidence.json','URL':'https://example.com/docs/evidence/x.json',
    'plain text':'test record','no json name':'docs/evidence/x.txt','outside docs/evidence':'docs/other/x.json','repo root file':'x.json',
    'digest too short':digest.slice(1),'digest too long':digest+'0','digest with a non-hex char':digest.slice(1)+'g','leading dot segment':'docs/evidence/.hidden/x.json',
    'empty segment':'docs/evidence//x.json','trailing slash':'docs/evidence/x.json/','space':'docs/evidence/a b.json','env in middle':'docs/evidence/%X%.json'
  };
  for(const [label,bad] of Object.entries(forms))assert.throws(()=>validateBoundaryRecord({...ok,evidence:bad}),error=>error.code==='QR2_BOUNDARY_RECORD_INVALID',label);
  refused({record_id:'UNRECORDED',epochs:[{epoch:'E0',from:0,to:null}],evidence:null},/UNRECORDED/);
  assert.throws(()=>Object.assign(QR2_BOUNDARY_RECORD_UNRECORDED,{record_id:'x'}),TypeError);
});

test('arguments: boundaries is required, the option, limits and range are checked, nothing is read on a bad argument',async()=>{
  const {bot}=await simple();
  const base={ownerId:bot.owner.id,botId:bot.id,broker:'binance-global',from:bot.created_at,to:Date.now(),requestTime:Date.now()};
  await assert.rejects(readQr2Account(store,base),{code:'QR2_INPUT_INVALID'});
  await assert.rejects(readQr2Account(store,{...base,boundaries:LOCAL_FIXTURE_E2,broker:'nyse'}),{code:'QR2_INPUT_INVALID'});
  await assert.rejects(readQr2Account(store,{...base,boundaries:{record_id:'X',epochs:[],evidence:null}}),{code:'QR2_BOUNDARY_RECORD_INVALID'});
  await assert.rejects(readQr2Account(store,{...base,boundaries:LOCAL_FIXTURE_E2,to:base.from}),{code:'QR2_RANGE_INVALID'});
  await assert.rejects(readQr2Account(store,{...base,boundaries:LOCAL_FIXTURE_E2,limits:{ledger_rows:0}}),{code:'QR2_INPUT_INVALID'});
  await assert.rejects(readQr2Account(store,{...base,boundaries:LOCAL_FIXTURE_E2,option:'X'}),{code:'QR2_INPUT_INVALID'});
  // A caller may lower a limit and never raise it; an unknown limit name is refused.
  for(const limits of [{ledger_rows:QR2_READ_LIMITS.ledger_rows+1},{ledger_rows:1e9},{grid_instants:QR2_READ_LIMITS.grid_instants+1},{audit_rows:1e9},{pending_orders:1e9},{rows:5},[]])
    await assert.rejects(readQr2Account(store,{...base,boundaries:LOCAL_FIXTURE_E2,limits}),{code:'QR2_INPUT_INVALID'},JSON.stringify(limits));
  assert.equal(QR2_READ_LIMITS.ledger_rows,5000,'provisional until S3 optimises the replay');
  const atLimits=await readQr2Account(store,{...base,boundaries:LOCAL_FIXTURE_E2,limits:{...QR2_READ_LIMITS}});
  assert.deepEqual(atLimits.reader.limits,QR2_READ_LIMITS);
});

test('T1 golden E2 through the live ledger: deposit, partial BUY fills with fees, targeted EXIT, FIFO exits to flat, withdrawal, deposit',async()=>{
  const now=Date.now();
  await priceTable([barOf(Math.floor((now-1000)/60000)*60000,'62000')]);
  const bot=await newBot(10000);                                                   // deposit +10000
  // BUY A 0.02 in two fills: 0.01 for 600 (fee 0.6) and 0.01 for 610 (fee 0.61); lots cost (600+0.6)/0.01 = 60060 and (610+0.61)/0.01 = 61061.
  await book(store,bot,'gA',{side:'BUY',steps:[{qty:'0.01',quote:'600',fee:'0.6'},{qty:'0.02',quote:'1210',fee:'0.61'}]});
  // BUY B 0.01 for 620 (fee 0.62): lot cost 62062.
  await book(store,bot,'gB',{side:'BUY',steps:[{qty:'0.01',quote:'620',fee:'0.62'}]});
  // Targeted EXIT of lot B (Bridge style, by entry_trade_id): 0.01 for 630 (fee 0.63). Removes 620.62, realized 630 - 620.62 - 0.63 = 8.75.
  await book(store,bot,'gX',{side:'SELL',target:'gB',steps:[{qty:'0.01',quote:'630',fee:'0.63'}]});
  // FIFO exit 0.015 for 960 (fee 0.96): all of lot 1 (600.6) and 0.005 of lot 2 (0.005 x 61061 = 305.305) = 905.905; realized 960 - 905.905 - 0.96 = 53.135.
  await book(store,bot,'gF',{side:'SELL',steps:[{qty:'0.015',quote:'960',fee:'0.96'}]});
  await setCapital(store,bot,9000);                                                                  // withdrawal -1000
  // Exit to flat 0.005 for 325 (fee 0.325): removes 305.305; realized 325 - 305.305 - 0.325 = 19.37.
  await book(store,bot,'gZ',{side:'SELL',steps:[{qty:'0.005',quote:'325',fee:'0.325'}]});
  await setCapital(store,bot,9500);                                                                  // deposit +500
  const result=await read(bot);
  // Hand values: realized 8.75 + 53.135 + 19.37 = 81.255; fees 0.6+0.61+0.62+0.63+0.96+0.325 = 3.745; flat, so NAV = cash = 10000 - 1000 + 500 + 81.255.
  for(const key of ['R1','R2','R4','R5','R6','R7','R11','RC','RI','N'])assert.equal(result.gates.gates[key].ok,true,key);
  assert.equal(result.gates.findings.length,0);
  assert.equal(result.commit_order.results.length,9);
  assert.ok(result.commit_order.results.every(r=>r.status==='MATCH'),'R3c MATCH at every snapshot');
  assert.equal(result.status.status,'COMPLETE');
  const to=result.performance.nav_to;
  assert.equal(to.nav,'9581.255');assert.equal(to.cash,'9581.255');assert.equal(to.realized,'81.255');assert.equal(to.position_cost,'0');
  assert.deepEqual(result.performance.flows.map(f=>f.amount),['10000','-1000','500']);
  assert.equal(result.performance.money_pnl.value,'81.255');
  assert.equal(result.performance.identity.ok,true);
  assert.equal(result.replay.final.fees,'3.745');
  assert.notEqual(result.performance.twr.value,null);
  // Independent SQL for the same facts.
  assert.equal((await db.query('SELECT sum(f.fee_quote)::text AS fees FROM fills f JOIN signals s ON s.id=f.signal_id WHERE s.user_id=$1',[bot.id])).rows[0].fees.replace(/\.?0+$/,''),'3.745');
  assert.equal(result.rows.cash,'9581.255');
  assert.deepEqual(result.ledger_rule_epochs,['E2']);
  assert.equal(result.marker_counts.AGREES,6);
  assert.equal(result.reader.isolation,'repeatable read');
  assert.equal(result.reader.read_only,true);
  assert.ok(result.reader.read_ms>=0&&result.reader.compute_ms>=0);
});

/* ------------------------------------------------------------------ T2 injected faults (a fresh Bot each) */

async function faulted(sql,params=()=>[],{capture=false}={}){
  const {bot,buy,sell}=await simple();
  const baseline=await read(bot);
  assert.equal(baseline.performance.nav_to.nav,'10016');
  await db.query(sql,params({bot,buy,sell}));
  const digest=await ledgerDigest(db,bot);
  const result=await read(bot);
  assert.deepEqual(await ledgerDigest(db,bot),digest,'the read changed no ledger row');
  return {bot,buy,sell,baseline,result};
}

test('T2 cost_basis +1e-18: R7 COST_DRIFT, SPLIT_NULL for the symbol, NAV and returns unchanged',async()=>{
  const {baseline,result}=await faulted('UPDATE public.ledger_positions SET cost_basis=cost_basis+0.000000000000000001 WHERE user_id=$1',({bot})=>[bot.id]);
  const failure=result.gates.gates.R7.failures[0];
  assert.deepEqual([failure.code,failure.symbol,failure.expected,failure.actual],['COST_DRIFT','BTCUSDT','360.000000000000000001','360']);
  assert.ok(result.gates.effects.split_null.has('BTCUSDT'));
  assert.equal(result.performance.nav_to.nav,'10016');
  assert.equal(result.performance.twr.value,baseline.performance.twr.value);
  assert.equal(result.performance.money_pnl.value,baseline.performance.money_pnl.value);
  assert.equal(result.performance.nav_to.position_cost,null,'the cost of the symbol is null');
  assert.equal(result.status.status,'PARTIAL');assert.ok(result.status.reasons.includes('SPLIT_NULL'));
});

test('T2 journal row deleted: R1 FILL_WITHOUT_JOURNAL, RECONCILIATION_FAILED, no number',async()=>{
  const {result}=await faulted('DELETE FROM public.paper_cash_journal WHERE signal_id=$1',({buy})=>[buy.id]);
  assert.ok(result.gates.gates.R1.failures.some(f=>f.reason==='FILL_WITHOUT_JOURNAL'));
  assert.equal(result.gates.effects.reconciliation_failed,true);
  assert.equal(result.status.status,'UNAVAILABLE');
  for(const key of ['money_pnl','twr','mwr','max_drawdown'])assert.equal(result.performance[key].value,null,key);
});

test('T2 journal cash +1e-18: R2 names the expected and the stored value, no corrected number',async()=>{
  const {result}=await faulted('UPDATE public.paper_cash_journal SET cash_delta=cash_delta+0.000000000000000001 WHERE signal_id=$1',({buy})=>[buy.id]);
  const failure=result.gates.gates.R2.failures[0];
  assert.deepEqual([failure.expected,failure.actual],['-600','-599.999999999999999999']);
  assert.equal(result.status.status,'UNAVAILABLE');
  assert.equal(result.performance.money_pnl.value,null);
});

test('T2/T3 the F4 false snapshot: a FUNDING snapshot that equals the state before the fill is FUNDING_SNAPSHOT_STALE (diagnostic, no number changed)',async()=>{
  // Labelled F4 row set: BUY 0.01 for 600 (fill snapshot), then a withdrawal of 1000 whose snapshot is rewritten to ignore the fill:
  // cash 10000 - 1000 = 9000, book equity 9000, position cost 0 (the state without the fill, only the funding row applied).
  const {bot}=await simple();
  await setCapital(store,bot,9000);
  const last=(await db.query("SELECT id FROM public.paper_snapshots WHERE user_id=$1 AND reason='FUNDING' ORDER BY id DESC LIMIT 1",[bot.id])).rows[0].id;
  await db.query('UPDATE public.paper_snapshots SET cash=9000,book_equity=9000,position_cost=0 WHERE id=$1',[last]);
  const result=await read(bot);
  const stale=result.commit_order.results.filter(r=>r.status==='FUNDING_SNAPSHOT_STALE');
  assert.equal(stale.length,1);assert.equal(stale[0].stale_over_fills,2);
  assert.equal(result.commit_order.ok,false);
  assert.equal(result.performance.nav_to.cash,'8644');           // 10000 - 1000 - 600 + 244
});

test('T2 negative cash after S_cash: N1 violation and a ledger-invariant span',async()=>{
  const {result}=await faulted('UPDATE public.paper_cash_journal SET cash_delta=-20000 WHERE signal_id=$1',({buy})=>[buy.id]);
  const n1=result.gates.gates.N.violations.find(v=>v.check==='N1');
  assert.ok(n1&&Number(n1.value)<0);
  assert.equal(result.gates.effects.ledger_invariant_violated,true);
  assert.ok(result.gates.gates.R2.failures.length>0,'the same fault also fails R2');
});

test('T2 extra lot: ORPHAN_LOT and R5, SPLIT_NULL, NAV unchanged',async()=>{
  const {result}=await faulted(`INSERT INTO public.ledger_position_allocations(position_id,user_id,account_id,execution_mode,broker,symbol,entry_signal_id,entry_trade_id,status,filled_quantity,remaining_quantity,entry_price,opened_at,updated_at)
    SELECT 'pos_extra',user_id,account_id,execution_mode,broker,symbol,entry_signal_id,entry_trade_id,'OPEN','0.001','0.001','60000',opened_at+1,opened_at+1 FROM public.ledger_position_allocations WHERE entry_signal_id=$1`,({buy})=>[buy.id]);
  assert.ok(code(result,'R6').includes('ORPHAN_LOT'));
  assert.equal(result.gates.gates.R5.ok,false);
  assert.ok(result.gates.effects.split_null.has('BTCUSDT'));
  assert.equal(result.performance.nav_to.nav,'10016');
});

test('T2 foreign journal row on an own signal: QR2_CROSS_BOT_ROW refuses the view and no foreign id, row or amount leaves the reader',async()=>{
  const other=await createBot(store,owner,5000);
  // Labelled fault: the journal row of the BUY now names another Bot and a cash amount that appears nowhere else in the account.
  const {result}=await faulted('UPDATE public.paper_cash_journal SET user_id=$2,cash_delta=-777.123456 WHERE signal_id=$1',({buy})=>[buy.id,other.id]);
  assert.equal(result.gates.refused,'QR2_CROSS_BOT_ROW');
  assert.equal(result.refused,'QR2_CROSS_BOT_ROW');
  assert.equal(result.status.status,'REFUSED');
  assert.deepEqual(result.status.reasons,['QR2_CROSS_BOT_ROW']);
  assert.equal(result.rows,null);assert.equal(result.cutoffs,null);
  for(const key of ['replay','performance','commit_order','facts','seeds'])assert.equal(key in result,false,key+' is not part of a refused view');
  const text=JSON.stringify(result);
  for(const foreign of [other.id,'777.123456','-777'])assert.equal(text.includes(foreign),false,'no '+foreign+' in the refused view');
  assert.deepEqual(result.gates.row_scope.findings,[{check:'RX',code:'QR2_CROSS_BOT_ROW',table:'journal',count:1}]);
  // Z1: the audit entry carries an opaque event key (a hash of code, table and the offending row), never the row key itself.
  assert.equal(result.audit_findings.length,1);
  const {event_key,...entry}=result.audit_findings[0];
  assert.deepEqual(entry,{check:'RX',code:'QR2_CROSS_BOT_ROW',table:'journal'});
  assert.match(event_key,/^row:journal:[0-9a-f]{64}$/);
  assert.equal(Number(result.reader.counts.journal),2,'the budget pre-count includes the foreign journal row found on an own signal');
});

test('T2 a LIVE-mode signal that has a fill: QR2_NON_PAPER_ROW refuses the view',async()=>{
  const {result}=await faulted("UPDATE public.signals SET execution_mode='LIVE' WHERE id=$1",({buy})=>[buy.id]);
  assert.equal(result.gates.refused,'QR2_NON_PAPER_ROW');
  assert.equal(result.status.status,'REFUSED');
  assert.equal(result.rows,null);assert.equal('performance' in result,false);assert.equal('replay' in result,false);
  assert.ok(result.audit_findings.length>0&&result.audit_findings.every(f=>f.check==='RP'&&f.code==='QR2_NON_PAPER_ROW'&&typeof f.table==='string'));
  assert.equal(JSON.stringify(result).includes('LIVE'),false,'the mode of the row is not returned');
});

test('T2 the replay input holds the immutable lot fields only: a changed remaining_quantity, status or closed_at moves the gates and never the replay',async()=>{
  const {bot}=await simple();
  const baseline=await read(bot);
  assert.equal(baseline.gates.gates.R5.ok,true);
  // Labelled fault: the mutable lot fields no longer agree with the replayed lots.
  await db.query("UPDATE public.ledger_position_allocations SET remaining_quantity='0.001',status='CLOSED',closed_at=1 WHERE user_id=$1",[bot.id]);
  const result=await read(bot);
  assert.deepEqual(result.replay,baseline.replay);
  assert.equal(result.gates.gates.R5.ok,false);
});

/* ------------------------------------------------------------------ T4 separation */

test('T4 separation: READ ONLY (an injected write fails 25006), a READ COMMITTED parent is refused, nothing but reads happens',async()=>{
  const {bot}=await simple();
  const digest=await ledgerDigest(db,bot);
  await assert.rejects(db.transaction(async()=>{
    const result=await read(bot);
    assert.equal(result.reader.isolation,'serializable');
    await db.query("INSERT INTO public.audit(user_id,ts,event,details) VALUES($1,1,'qr2.test','{}')",[bot.id]);
  },{isolation:'SERIALIZABLE'}),error=>error.code==='25006');
  await assert.rejects(db.transaction(async()=>{await db.query('SELECT 1');return read(bot);}),{code:'QR2_READER_SNAPSHOT_REQUIRED'});
  assert.deepEqual(await ledgerDigest(db,bot),digest,'every ledger table and paper_ledger_fence.version are unchanged');
  await read(bot);
  assert.deepEqual(await ledgerDigest(db,bot),digest);
});

test('T4 a refused READ COMMITTED parent stays read-write: the isolation is checked before READ ONLY is set',async()=>{
  const {bot}=await simple();
  await db.transaction(async()=>{
    await assert.rejects(read(bot),{code:'QR2_READER_SNAPSHOT_REQUIRED'});
    assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only,'off');
  });
});

test('T4 snapshot proof: a fill committed by another connection after the first read is not seen, and neither side gets 40001',async()=>{
  const {bot}=await simple();
  const second=openSecond(fx);
  try{
    let inside;
    await db.transaction(async()=>{
      await db.query('SELECT count(*) FROM public.fills');                                       // the snapshot is taken here
      await book(second.store,bot,'late-'+bot.id.slice(0,6),{side:'BUY',steps:[{qty:'0.001',quote:'60'}]});   // another connection commits a fill
      inside=await read(bot);
    },{isolation:'REPEATABLE READ'});
    assert.equal(inside.cutoffs.fill_count,2,'the reader saw the pre-fill snapshot');
    assert.equal((await read(bot)).cutoffs.fill_count,3);
  }finally{await second.close();}
});

test('T4 import graph and SQL allowlist: no network, research or quant module, only the allowed tables, schema-qualified, no write statement',()=>{
  const reader=fs.readFileSync(new URL('../../src/postgres/qr2-reader.js',import.meta.url),'utf8');
  const audit=fs.readFileSync(new URL('../../src/postgres/qr2-audit.js',import.meta.url),'utf8');
  for(const [name,text] of [['reader',reader],['audit',audit]]){
    const imports=[...text.matchAll(/^import .* from '([^']+)'/gm)].map(m=>m[1]);
    assert.ok(imports.length>0);
    for(const specifier of imports)assert.doesNotMatch(specifier,/fetch|market-proxy|market-ohlcv|research|quant|pine-bridge|node:(http|https|net|tls|dgram|child_process)|^pg$/,name+' imports '+specifier);
    assert.doesNotMatch(text,/\bfetch\(|XMLHttpRequest|WebSocket|child_process/,name+' calls no network');
  }
  assert.doesNotMatch(reader,/\b(INSERT\s+INTO|UPDATE\s+public|DELETE\s+FROM|FOR\s+UPDATE|pg_advisory|bumpPaperLedgerFence|recordFunding|recordExecution)/i);
  const allowed=new Set(['users','paper_funding','paper_cash_journal','fills','signals','ledger_position_allocations','ledger_positions','paper_snapshots','audit','pine_market_bars']);
  const tables=[...reader.matchAll(/\b(?:FROM|JOIN)\s+(public\.)?([a-z_]+)/gi)].filter(m=>!['unnest','the','one','an'].includes(m[2].toLowerCase()));
  const found=new Set(tables.filter(m=>/_|^(users|fills|signals|audit)$/.test(m[2])).map(m=>m[2].toLowerCase()));
  for(const name of found)assert.ok(allowed.has(name),'table '+name+' is on the allowlist');
  assert.ok(found.size>=8);
  for(const m of tables)if(allowed.has(m[2].toLowerCase()))assert.equal(m[1],'public.','table '+m[2]+' is schema-qualified');
});

/* ------------------------------------------------------------------ T5 epochs and boundaries */

test('T5 UNRECORDED: the first fill is LEDGER_RULE_UNREPLAYABLE and the range reaching it is UNAVAILABLE; a funding-only account still has NAV',async()=>{
  const {bot}=await simple();
  const result=await read(bot,{boundaries:QR2_BOUNDARY_RECORD_UNRECORDED});
  assert.equal(result.replay.halted.code,'LEDGER_RULE_UNREPLAYABLE');
  assert.equal(result.replay.unreplayable_from.reason,'EPOCH_UNKNOWN');
  assert.equal(result.replay.halted.key,String(result.rows.fills[0].signal_id)+':0.01');
  assert.equal(result.status.status,'UNAVAILABLE');assert.ok(result.status.reasons.includes('RECONCILIATION_FAILED'));
  assert.equal(result.performance.money_pnl.value,null);
  const funded=await newBot(2500);
  const only=await read(funded,{boundaries:QR2_BOUNDARY_RECORD_UNRECORDED});
  assert.equal(only.performance.nav_to.nav,'2500');assert.equal(only.performance.money_pnl.value,'0');
  assert.equal(only.status.status,'COMPLETE');
});

test('T5 a gap between boundary records is LEDGER_RULE_UNREPLAYABLE at the first fill inside it; the earlier fill keeps its epoch',async()=>{
  const {bot}=await simple();
  const [first,second]=(await read(bot)).rows.fills;
  const gap=validateBoundaryRecord({record_id:'LOCAL_GAP',epochs:[{epoch:'E0',from:0,to:first.received_at+1},{epoch:'E2',from:second.received_at+1,to:null}],lot_fee_boundary:0,lot_table_boundary:0,evidence:'docs/evidence/test-record.json'});
  const result=await read(bot,{boundaries:gap});
  assert.equal(result.replay.events.find(e=>e.kind==='FILL').epoch,'E0');
  assert.equal(result.replay.halted.key,second.signal_id+':0.004');
  assert.equal(result.replay.halted.code,'LEDGER_RULE_UNREPLAYABLE');
});

test('T5 the marker is corroboration: a boundary record that says E1 for E2-booked fills counts DISAGREES and replays the same numbers',async()=>{
  const {bot}=await simple();
  const record=validateBoundaryRecord({record_id:'LOCAL_E1',epochs:[{epoch:'E1',from:0,to:null}],lot_fee_boundary:0,lot_table_boundary:0,evidence:'docs/evidence/test-record.json'});
  const result=await read(bot,{boundaries:record});
  assert.deepEqual(result.marker_counts,{AGREES:0,DISAGREES:2,ABSENT:0});
  assert.equal(result.replay.halted,null);
  assert.equal(result.performance.nav_to.nav,'10016');
});

test('T5 lot-fee boundary: a lot priced without the fee is LOT_EPOCH_UNKNOWN when no boundary is recorded and matches when the lot predates the recorded boundary',async()=>{
  await priceTable([barOf(Math.floor((Date.now()-1000)/60000)*60000,'62000')]);
  const bot=await newBot(10000);
  await book(store,bot,'fee-buy',{side:'BUY',steps:[{qty:'0.01',quote:'600',fee:'0.6'}]});
  // Labelled old-lot fault: entry_price as before b74ba50 (quote / quantity = 60000, fee excluded).
  await db.query("UPDATE public.ledger_position_allocations SET entry_price='60000' WHERE user_id=$1",[bot.id]);
  const unknown=validateBoundaryRecord({record_id:'LOCAL_NO_FEE_BOUNDARY',epochs:[{epoch:'E2',from:0,to:null}],lot_fee_boundary:null,lot_table_boundary:0,evidence:'docs/evidence/test-record.json'});
  const absent=await read(bot,{boundaries:unknown});
  assert.ok(absent.gates.findings.concat(absent.gates.information).some(f=>f.code==='LOT_EPOCH_UNKNOWN'));
  const lotAt=absent.rows.lots[0].opened_at;
  const known=validateBoundaryRecord({record_id:'LOCAL_FEE_BOUNDARY',epochs:[{epoch:'E2',from:0,to:null}],lot_fee_boundary:lotAt+1,lot_table_boundary:0,evidence:'docs/evidence/test-record.json'});
  const present=await read(bot,{boundaries:known});
  assert.equal(present.gates.findings.filter(f=>f.check==='R6').length,0);
});

/* ------------------------------------------------------------------ T6 prices */

test('T6 prefetch differential: the reader result equals the library run on every bar of the table (FRESH, STALE, older than carry, none, tampered, flat, absent table)',async()=>{
  const cases=[];
  const open=async(label,bars,mutate,option='M')=>{
    const now=Date.now();
    await priceTable(bars(now));
    const bot=await newBot(10000);
    await book(store,bot,'d-'+label,{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
    if(mutate)await mutate(bot);
    const requestTime=Date.now();
    const result=await read(bot,{requestTime,option});
    const all=(await db.query('SELECT broker,symbol,timeframe,bar_time,bar,provenance,content_hash FROM public.pine_market_bars ORDER BY bar_time')).rows;
    const full=rangePerformance({replay:result.replay,seeds:result.seeds,effects:result.gates.effects,from:result.range.resolved.from,to:result.range.resolved.to,rows:all,broker:'binance-global',commitOrder:result.commit_order,option});
    assert.deepEqual(result.performance,full,label+': prefetch equals the full table');
    cases.push([label,result]);
    return result;
  };
  const fresh=await open('fresh',now=>[barOf(Math.floor((now-1000-60000)/60000)*60000,'62000'),barOf(Math.floor((now-1000-120000)/60000)*60000,'50000')]);
  assert.equal(fresh.performance.nav_to.positions[0].state,'FRESH');assert.equal(fresh.performance.nav_to.nav,'10020');            // 10000 - 600 + 0.01 x 62000
  const stale=await open('stale',now=>[barOf(Math.floor((now-300000)/60000)*60000,'61000')]);
  assert.equal(stale.performance.nav_to.positions[0].state,'STALE');assert.equal(stale.performance.money_pnl.status,'COMPLETE');
  const older=await open('older',now=>[barOf(Math.floor((now-1200000)/60000)*60000,'61000')]);
  assert.equal(older.performance.nav_to.nav,null);assert.equal(older.performance.nav_to.positions[0].state,'UNAVAILABLE');
  assert.ok(older.performance.money_pnl.reasons.includes('UNAVAILABLE'));
  const none=await open('none',()=>[]);
  assert.equal(none.performance.nav_to.nav,null);assert.equal(none.facts.market_data.bars,0);
  const tampered=await open('tampered',now=>[barOf(Math.floor((now-1000-60000)/60000)*60000,'62000')],()=>db.query("UPDATE public.pine_market_bars SET content_hash=repeat('0',64)"));
  assert.equal(tampered.performance.nav_to.positions[0].state,'PRICE_INTEGRITY_FAILED');assert.equal(tampered.performance.nav_to.nav,null);
  assert.equal(cases.length,5);
  // Flat account without any fill: no valuation price query; independent coverage is still read.
  const flat=await newBot(1000);
  const flatResult=await read(flat);
  assert.equal(flatResult.facts.market_data.checked,false);assert.equal(flatResult.performance.nav_to.nav,'1000');
});

test('T6 option R: the prefetch skips a bar retrieved after the instant like the library and equals the full-table run; option M still takes that bar',async()=>{
  await db.query('DELETE FROM public.pine_market_bars');
  const bot=await newBot(10000);
  await book(store,bot,'r-buy',{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  const requestTime=Date.now();
  // Minute-aligned b1 is 120 to <180 s old and retrieved in time (50000); b2 is 60 to <120 s old (62000).
  const b1=Math.floor(requestTime/60000)*60000-120000,b2=Math.floor(requestTime/60000)*60000-60000;
  await insertBars(db,[barOf(b1,'50000')],{retrievedAt:requestTime-100000});
  await insertBars(db,[barOf(b2,'62000')],{retrievedAt:requestTime+5000});
  const allBars=async()=>(await db.query('SELECT broker,symbol,timeframe,bar_time,bar,provenance,content_hash FROM public.pine_market_bars ORDER BY bar_time')).rows;
  const chosen=async option=>{
    const result=await read(bot,{requestTime,option});
    const full=rangePerformance({replay:result.replay,seeds:result.seeds,effects:result.gates.effects,from:result.range.resolved.from,to:result.range.resolved.to,rows:await allBars(),broker:'binance-global',commitOrder:result.commit_order,option});
    assert.deepEqual(result.performance,full,'option '+option+': prefetch equals the full table');
    return result.performance.nav_to.positions[0];
  };
  const setRetrieved=json=>db.query("UPDATE public.pine_market_bars SET provenance=jsonb_set(provenance,'{retrieved_at}',$1::jsonb) WHERE bar_time=$2",[json,b2]);
  // retrieved_at after the request time: option M takes b2, option R skips it (NO_PRICE_ROW for b2 would be the bug) and takes b1.
  const viaM=await chosen('M');
  assert.deepEqual([viaM.bar_time,viaM.price],[b2,'62000']);
  const viaR=await chosen('R');
  assert.deepEqual([viaR.bar_time,viaR.price],[b1,'50000']);
  // Z3: a JSON-number retrieved_at that is not a non-negative safe integer is refused QR2_INPUT_INVALID (detail RETRIEVED_AT) before any SQL
  // cast: a fraction, a tiny number (float8 would raise 22003), a negative, 2^53, a number above 2^53 and a huge number. Option M never reads it.
  const refusedR=async label=>{
    await assert.rejects(read(bot,{requestTime,option:'R'}),error=>error.code==='QR2_INPUT_INVALID'&&error.detail==='RETRIEVED_AT',label);
    assert.equal((await read(bot,{requestTime,option:'M'})).performance.nav_to.positions[0].bar_time,b2,label+': option M ignores it');
  };
  for(const [label,json] of Object.entries({
    'fraction':String(requestTime+5000)+'.5','tiny number':'1e-400','tiny but not zero':'0.0000000000000000000000001','negative':'-5','negative zero fraction':'-0.5',
    '2^53':'9007199254740992','above 2^53 (16 digits)':'9007199254740993','17 digits':'12345678901234567','huge':'1e20','huge integer text':'100000000000000000000'
  })){await setRetrieved(json);await refusedR(label);}
  // The largest safe integer and zero are valid numbers: 2^53 - 1 is after the request time (skipped), 0 is before it (usable).
  await setRetrieved('9007199254740991');
  assert.equal((await chosen('R')).bar_time,b1,'2^53 - 1 is a safe integer after the request time');
  await setRetrieved('0');
  assert.equal((await chosen('R')).bar_time,b2,'zero is retrieved in time');
  // A string retrieved_at is not a number: it keeps the bar usable.
  await setRetrieved(JSON.stringify(String(requestTime+5000)));
  assert.equal((await chosen('R')).bar_time,b2,'a string retrieved_at is not a number');
  await db.query("UPDATE public.pine_market_bars SET provenance=provenance-'retrieved_at' WHERE bar_time=$1",[b2]);
  assert.equal((await chosen('R')).bar_time,b2,'no retrieved_at is usable');
  // retrieved_at exactly at or before the request time is retrieved in time.
  await setRetrieved(String(requestTime));
  assert.equal((await chosen('R')).bar_time,b2);
  await setRetrieved(String(requestTime+1));
  assert.equal((await chosen('R')).bar_time,b1);
});

test('T6 the price table can be absent: MARKET_DATA_TABLE_ABSENT, no price, the account is not refused',async()=>{
  const bot=(await simple()).bot;
  await db.query('ALTER TABLE public.pine_market_bars RENAME TO pine_market_bars_hidden');       // labelled fixture exception
  try{
    const result=await read(bot);
    assert.equal(result.facts.market_data.gap,'MARKET_DATA_TABLE_ABSENT');assert.equal(result.facts.market_data.table_present,false);
    assert.equal(result.performance.nav_to.nav,null);
  }finally{await db.query('ALTER TABLE public.pine_market_bars_hidden RENAME TO pine_market_bars');}
});

/* ------------------------------------------------------------------ T7 budget, T8 scope, T9 cutoffs */

test('T7 read budget: over the ledger-row limit or a long range is refused before any fetch; the grid set size and the limits at the limit are allowed; nothing is truncated',async()=>{
  const {bot}=await simple();
  const seen=[];
  const original=db.query.bind(db);
  db.query=(sql,params)=>{seen.push(String(sql));return original(sql,params);};
  try{
    const ok=await read(bot);
    const total=ok.reader.counts.total,instants=ok.facts.market_data.instants;
    assert.equal(total,Number(ok.reader.counts.fundings)+Number(ok.reader.counts.journal)+Number(ok.reader.counts.fills)+Number(ok.reader.counts.lots)+Number(ok.reader.counts.snapshots));
    seen.length=0;
    await assert.rejects(read(bot,{limits:{ledger_rows:total-1}}),error=>error.code==='QR2_RANGE_ADMISSION_REFUSED'&&error.detail.limit==='ledger_rows'&&error.detail.value===total);
    assert.ok(seen.every(sql=>!/FROM public\.(paper_funding|fills|paper_cash_journal|ledger_position|paper_snapshots|audit|pine_market_bars) /.test(sql)||/count\(\*\)/.test(sql)),'no row fetch ran before the refusal');
    assert.equal((await read(bot,{limits:{ledger_rows:total}})).reader.counts.total,total,'exactly at the limit is allowed');
    await assert.rejects(read(bot,{limits:{grid_instants:instants-1}}),error=>error.code==='QR2_RANGE_ADMISSION_REFUSED'&&error.detail.limit==='grid_instants');
    assert.equal((await read(bot,{limits:{grid_instants:instants}})).facts.market_data.instants,instants);
    assert.deepEqual(Object.keys(QR2_READ_LIMITS).sort(),['audit_rows','grid_instants','ledger_rows','pending_orders']);
    // A long history is refused by arithmetic, before the instants are built (labelled fixture exception: an account registered 3000 days ago).
    await db.query('UPDATE public.users SET created_at=created_at-3000::bigint*86400000 WHERE id=$1',[bot.id]);
    const old=(await db.query('SELECT created_at FROM public.users WHERE id=$1',[bot.id])).rows[0].created_at;
    seen.length=0;
    await assert.rejects(read(bot,{from:old,limits:{grid_instants:100}}),error=>error.code==='QR2_RANGE_ADMISSION_REFUSED'&&error.detail.limit==='grid_instants'&&error.detail.value>=3000);
    assert.ok(seen.every(sql=>!/count\(\*\)|FROM public\.(paper_funding|fills|paper_cash_journal|ledger_position|paper_snapshots|audit|pine_market_bars) /.test(sql)),'the range arithmetic refuses before the pre-count and before any fetch');
  }finally{db.query=original;}
});

test('T8 owner scope: owner A cannot read owner B Bot; own child Bot and the own main account are allowed',async()=>{
  const ownerB=await createOwner(store);
  const botB=await createBot(store,ownerB,3000);
  await assert.rejects(read(botB,{},owner),{code:'QR2_NOT_OWNER'});
  await assert.rejects(readQr2Account(store,{ownerId:owner.id,botId:'no-such-bot',broker:'binance-global',from:1,to:2,requestTime:3,boundaries:LOCAL_FIXTURE_E2}),{code:'QR2_NOT_OWNER'});
  const own=await createBot(store,owner,3000);
  assert.equal((await read(own,{},owner)).scope.bot_id,own.id);
  assert.equal((await read(botB,{},ownerB)).scope.owner_id,ownerB.id);
  const main=await read(owner,{},owner);                                                         // the main account is its own Bot (id = owner)
  assert.equal(main.scope.bot_id,owner.id);
});

test('T9 cutoffs equal independent SQL maxima and counts, and describe the rows used',async()=>{
  const {bot}=await simple();
  const requestTime=Date.now();
  const result=await read(bot,{requestTime});
  const one=async(sql,params=[bot.id])=>(await db.query(sql,params)).rows[0];
  const sqlFund=await one('SELECT max(id) AS m FROM public.paper_funding WHERE user_id=$1 AND broker=\'binance-global\'');
  const sqlSnap=await one('SELECT max(id) AS m FROM public.paper_snapshots WHERE user_id=$1 AND broker=\'binance-global\'');
  const sqlFills=await one('SELECT count(*) AS n FROM public.fills f JOIN public.signals s ON s.id=f.signal_id WHERE s.user_id=$1');
  const sqlLast=await one('SELECT f.received_at,f.signal_id,f.cumulative_quantity FROM public.fills f JOIN public.signals s ON s.id=f.signal_id WHERE s.user_id=$1 ORDER BY f.received_at DESC,f.signal_id DESC,f.cumulative_quantity DESC LIMIT 1');
  const sqlLots=await one('SELECT count(*) AS n FROM public.ledger_position_allocations WHERE user_id=$1');
  const sqlBar=await one("SELECT max(bar_time) AS m FROM public.pine_market_bars WHERE broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1' AND bar_time<=$1",[requestTime]);
  assert.deepEqual(result.cutoffs,{max_funding_id:sqlFund.m,max_snapshot_id:sqlSnap.m,fill_count:sqlFills.n,last_fill:{received_at:sqlLast.received_at,signal_id:sqlLast.signal_id,cumulative_quantity:sqlLast.cumulative_quantity},lot_count:sqlLots.n,market_data_cutoff:sqlBar.m});
});

/* ------------------------------------------------------------------ runtime role */

test('the reader runs as the runtime role of scripts/grant-postgres-runtime.sql and returns the same view as the owner role',async t=>{
  const {randomUUID}=await import('node:crypto');
  const pgModule=(await import('pg')).default;
  const {PostgresDatabase}=await import('../../src/postgres/db.js');
  const {Store}=await import('../../src/postgres/store.js');
  const {rolePasswordClause}=await import('../helpers/test-role-password.mjs');
  const rt=await createQr2Database('robot_qr2_rt');
  const admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL});
  const role='robot_qr2_role_'+randomUUID().replaceAll('-','');
  let runtimeDb=null;
  t.after(async()=>{
    await runtimeDb?.close().catch(()=>{});
    await rt.db.query('DROP OWNED BY '+role).catch(()=>{});
    await rt.dispose();
    await admin.query('DROP ROLE IF EXISTS '+role).catch(()=>{});
    await admin.close();
  });
  // The extension schemas, in the order of test/postgres/runtime-grants.test.mjs (the pine-bridge schema is already installed by the fixture).
  for(const file of ['quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql','quant-storage-schema.sql','quant-io-ledger-schema.sql','quant-io-runtime-schema.sql','quant-preflight-schema.sql','quant-profile-enrollment-schema.sql'])
    await rt.db.query(fs.readFileSync(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
  const o=await createOwner(rt.store),bot=await createBot(rt.store,o,10000);
  await insertBars(rt.db,[barOf(Math.floor((Date.now()-1000)/60000)*60000,'62000')]);
  await book(rt.store,bot,'rt-buy',{side:'BUY',steps:[{qty:'0.01',quote:'600'}]});
  await book(rt.store,bot,'rt-sell',{side:'SELL',steps:[{qty:'0.004',quote:'244'}]});
  await admin.query('CREATE ROLE '+role+' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'+rolePasswordClause());
  const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+rt.name;
  const script=fs.readFileSync(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8').replaceAll(":'runtime_role'","'"+role+"'");
  const client=new pgModule.Client({connectionString:url.toString()});await client.connect();
  try{await client.query(script);}finally{await client.end();}
  url.username=role;
  runtimeDb=new PostgresDatabase({connectionString:url.toString(),max:3});
  const runtimeStore=new Store(runtimeDb);
  const now=Date.now(),args={ownerId:o.id,botId:bot.id,broker:'binance-global',from:bot.created_at,to:now,requestTime:now,boundaries:LOCAL_FIXTURE_E2};
  const asRuntime=await readQr2Account(runtimeStore,args),asOwner=await readQr2Account(rt.store,args);
  assert.equal((await runtimeDb.query('SELECT current_user AS u')).rows[0].u,role);
  assert.equal(asRuntime.performance.nav_to.nav,'10016');
  assert.deepEqual(asRuntime.performance,asOwner.performance);
  assert.deepEqual(asRuntime.cutoffs,asOwner.cutoffs);
  assert.equal(asRuntime.status.status,'COMPLETE');
});
