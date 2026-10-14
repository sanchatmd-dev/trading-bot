import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ledgerMethods,recordFunding,bumpPaperLedgerFence} from '../src/postgres/ledger.js';
import {Store} from '../src/postgres/store.js';

// F4 fence call sites (design FD1-r2 slice S4, U1-U4): statement order against fake databases that record every statement,
// so the lock order the proof assumes (users row, then fence, then Paper reads) is checked without PostgreSQL.
const FENCE=/^INSERT INTO public\.paper_ledger_fence AS fence\(user_id,version,updated_at\) VALUES\(\?,1,\?\) ON CONFLICT\(user_id\) DO UPDATE SET version=fence\.version\+1,updated_at=excluded\.updated_at$/;
const USERS_LOCK='SELECT id FROM users WHERE id=? FOR UPDATE';
const PAPER_READ=/FROM (paper_funding|paper_cash_journal|ledger_positions|ledger_position_allocations)\b/;
const isFence=entry=>FENCE.test(entry.sql??'');
const fenceEntries=log=>log.filter(isFence);
const at=(log,predicate,label)=>{const index=log.findIndex(predicate);assert.notEqual(index,-1,label+' not found in '+JSON.stringify(log.map(e=>e.sql??e.call)));return index;};

// A db.prepare that records every statement it runs; answer(sql,params) supplies rows for the reads a case needs.
function recordingDb(log,answer=()=>undefined){
  const record=(sql,mode,fallback)=>async(...params)=>{log.push({sql,params});return answer(sql,params,mode)??fallback;};
  return {isTransaction:true,transaction:async fn=>fn(),prepare(sql){return {get:record(sql,'get',undefined),all:record(sql,'all',[]),run:record(sql,'run',{changes:1})};}};
}

test('the fence refuses a caller outside a transaction before any statement, and writes one upsert inside one',async()=>{
  const outside=[],db=recordingDb(outside);db.isTransaction=false;
  await assert.rejects(bumpPaperLedgerFence(db,'bot'),/Paper ledger fence requires a transaction/);
  assert.deepEqual(outside,[],'no statement ran');
  const inside=[];
  await bumpPaperLedgerFence(recordingDb(inside),'bot');
  assert.equal(inside.length,1);assert.ok(isFence(inside[0]));assert.equal(inside[0].params[0],'bot');
});

// U1 store: binance-global configured at 100/100, the other brokers at 0, no reservations.
function fundingStore(log){
  const configured={'binance-global':'100'};
  return {db:recordingDb(log,(sql)=>sql===USERS_LOCK?{id:'bot'}:undefined),
    async paperAccount(userId,broker){log.push({call:'paperAccount:'+broker});const c=configured[broker]??'0';return {configuredEquity:c,configuredBalance:c,cash:c,bookEquity:c,positionCost:'0'};},
    async exposure(){log.push({call:'exposure'});return {reservedNotional:'0',reservedFees:'0',feeReservationUnknown:false};},
    async snapshotPaper(userId,broker,reason){log.push({call:'snapshot:'+broker+':'+reason});}};
}
const capital=(equity,cash=equity,extra={})=>({equities:{'binance-global':equity,...extra.equities},balances:{'binance-global':cash,...extra.balances}});

test('U1 recordFunding validates every broker first, then locks the Bot, then writes the fence, then reads Paper state',async()=>{
  for(const [label,policy,deposit] of [['no capital change',capital('100'),false],['deposit',capital('150'),true]]){
    const log=[];
    await recordFunding(fundingStore(log),'bot',policy);
    assert.equal(log[0].sql,USERS_LOCK,label+': the Bot lock comes first');
    assert.ok(isFence(log[1]),label+': the fence comes right after the Bot lock');
    assert.equal(log[1].params[0],'bot');assert.equal(typeof log[1].params[1],'number');
    assert.equal(fenceEntries(log).length,1,label+': one fence write per call');
    assert.equal(log[2].call,'paperAccount:binance-global',label+': Paper state is read only after the fence');
    assert.equal(log.filter(e=>/^INSERT INTO paper_funding/.test(e.sql??'')).length,deposit?1:0,label+': funding rows');
  }
  // An invalid policy on the last broker, or a value beyond 18 places, refuses before any statement: a 400, never a 409.
  for(const [label,policy,message] of [
    ['cash above equity on settrade',capital('100','100',{equities:{settrade:'1'},balances:{settrade:'2'}}),/Invalid Paper capital/],
    ['negative cash on innovestx',capital('100','100',{equities:{innovestx:'1'},balances:{innovestx:'-1'}}),/Invalid Paper capital/],
    ['19 decimal places',capital('100.0000000000000000001'),/Maximum decimal scale is 18/]]){
    const log=[];
    await assert.rejects(recordFunding(fundingStore(log),'bot',policy),message,label);
    assert.deepEqual(log,[],label+': no lock, fence or read before validation');
  }
});

test('U1 a withdrawal refused on Paper state is refused after the fence, so the request rolls the fence back with it',async()=>{
  const log=[],store=fundingStore(log);
  store.exposure=async()=>{log.push({call:'exposure'});return {reservedNotional:'90',reservedFees:'5',feeReservationUnknown:false};};
  await assert.rejects(recordFunding(store,'bot',capital('100','90')),/withdrawal exceeds unreserved funds/);
  assert.equal(log[0].sql,USERS_LOCK);assert.ok(isFence(log[1]));
  assert.equal(log.filter(e=>/^INSERT INTO paper_funding/.test(e.sql??'')).length,0);
});

// U2 store: the real recordExecution over a fake database holding one signal and an empty Paper account.
function executionStore(log,status='PROCESSING'){
  const signal={id:7,user_id:'bot',trade_id:'T7',execution_mode:'PAPER',broker:'binance-global',symbol:'BTCUSDT',account_id:'binance-global:primary',
    applied_quantity:'0',applied_quote:'0',status,payload:'{}'};
  const answer=(sql)=>{
    if(sql===USERS_LOCK)return {id:'bot'};
    if(sql.includes('FROM signals WHERE id=? FOR UPDATE'))return signal;
    if(sql.includes('FROM paper_funding'))return {equity:'1000',cash:'1000'};
    if(sql.includes('COALESCE(SUM('))return {amount:'0'};
    return undefined;
  };
  const store={db:recordingDb(log,answer),...ledgerMethods,
    snapshotPaper:async()=>{log.push({call:'snapshot'});},complete:async()=>{log.push({call:'complete'});},audit:async()=>{log.push({call:'audit'});}};
  return {store,signal};
}
const buy={side:'BUY',quantity:'0.001',price:'60000',stopLoss:'59000',takeProfit:null,notional:'60'};

test('U2 recordExecution writes the fence after the Bot and signal locks and before any Paper read or write',async()=>{
  const log=[],{store,signal}=executionStore(log);
  await store.recordExecution(signal,{status:'FILLED',orderId:'x',executedQty:'0.001',quoteQty:'60',deltaFeeQuote:'0',raw:{}},buy);
  assert.equal(log[0].sql,USERS_LOCK);
  assert.match(log[1].sql,/FROM signals WHERE id=\? FOR UPDATE/);
  assert.ok(isFence(log[2]),'the fence follows the two locks');
  assert.deepEqual(log[2].params.slice(0,1),['bot'],'keyed by the Bot that owns the signal');
  assert.equal(fenceEntries(log).length,1);
  const firstPaper=at(log,e=>PAPER_READ.test(e.sql??'')||/INSERT INTO (paper_cash_journal|ledger_positions|ledger_position_allocations|fills)/.test(e.sql??''),'Paper statement');
  assert.ok(firstPaper>2,'no Paper read or write before the fence');
  assert.ok(log.some(e=>/^INSERT INTO paper_cash_journal/.test(e.sql??'')),'the fill was booked');
});

test('U2 a status-only update writes the fence; a signal already terminal returns before it',async()=>{
  const log=[],{store,signal}=executionStore(log);
  await store.recordExecution(signal,{status:'CANCELED',orderId:'x',executedQty:'0',quoteQty:'0',deltaFeeQuote:'0',raw:null},buy);
  assert.equal(fenceEntries(log).length,1,'every call that goes on to write takes the fence');
  for(const terminal of ['FILLED','CANCELED','REJECTED','EXPIRED']){
    const quiet=[],{store:other,signal:row}=executionStore(quiet,terminal);
    await other.recordExecution(row,{status:'FILLED',orderId:'x',executedQty:'0.001',quoteQty:'60',deltaFeeQuote:'0',raw:{}},buy);
    assert.equal(quiet.length,2,terminal+': only the two locks ran');
    assert.equal(fenceEntries(quiet).length,0,terminal+': no fence after the terminal early return');
  }
});

// U3: the real Store.transitionBotState over a recording database; the session and Paper accounts are stubs that log calls.
function lifecycleStore(log,session){
  const store=new Store(recordingDb(log,sql=>sql===USERS_LOCK?{id:'bot'}:undefined));
  store.getBotSession=async()=>{log.push({call:'getBotSession'});return {...session};};
  store.paperAccounts=async()=>{log.push({call:'paperAccounts'});return [{broker:'binance-global',cash:'60'},{broker:'settrade',cash:'0'}];};
  return store;
}
const sessionInsert=log=>log.find(e=>/^INSERT INTO bot_sessions/.test((e.sql??'').trim()));

test('U3 transitionBotState writes the fence and reads Paper accounts only for a run from SETUP, in that order',async()=>{
  const log=[],store=lifecycleStore(log,{state:'SETUP',run_id:null,locked_policy:null,initial_capital:null});
  // A caller that still passes a stale accounts list (scripts, older tests) cannot set the snapshot any more.
  const result=await store.transitionBotState('bot','run',{maxRiskPercent:1},[{broker:'binance-global',cash:'100'}]);
  assert.equal(result.state,'RUNNING');
  const lock=at(log,e=>e.sql===USERS_LOCK,'users lock'),fence=at(log,isFence,'fence'),read=at(log,e=>e.call==='paperAccounts','paperAccounts');
  assert.ok(lock<fence&&fence<read,'users lock, then fence, then the Paper read');
  assert.equal(fenceEntries(log).length,1);
  assert.equal(fenceEntries(log)[0].params[0],'bot');
  assert.equal(sessionInsert(log).params[4],JSON.stringify({'binance-global':'60',settrade:'0'}),'initial_capital is the cash read after the fence');
});

test('U3 resume, pause, stop and reset write no fence and read no Paper accounts',async()=>{
  const stored=JSON.stringify({'binance-global':'100'});
  for(const [label,session,action,state] of [
    ['resume from PAUSED',{state:'PAUSED',run_id:'r1',locked_policy:'{}',initial_capital:stored,started_at:1},'run','RUNNING'],
    ['pause',{state:'RUNNING',run_id:'r1',locked_policy:'{}',initial_capital:stored},'pause','PAUSED'],
    ['stop',{state:'RUNNING',run_id:'r1',locked_policy:'{}',initial_capital:stored},'stop','STOPPED'],
    ['reset',{state:'STOPPED',run_id:'r1',locked_policy:'{}',initial_capital:stored,started_at:1,stopped_at:2},'reset','SETUP']]){
    const log=[],store=lifecycleStore(log,session);
    assert.equal((await store.transitionBotState('bot',action,{})).state,state,label);
    assert.equal(fenceEntries(log).length,0,label+': no fence');
    assert.equal(log.filter(e=>e.call==='paperAccounts').length,0,label+': no Paper read');
    if(action==='run')assert.equal(sessionInsert(log).params[4],stored,label+': the stored snapshot is kept');
  }
});

// U4 structural guard: a new Paper writer must take the Bot lock and the fence (design D1), so every SQL text in src/postgres
// that writes paper_funding, paper_cash_journal or ledger_positions must live in recordFunding or recordExecution, after
// the fence call. A new writer fails here until its author adds the fence and extends this list.
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src/postgres');
const WRITER=/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|COPY)\s+(?:ONLY\s+)?(?:public\.)?"?(paper_funding|paper_cash_journal|ledger_positions)\b/gi;
const FENCE_WRITER=/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|COPY)\s+(?:ONLY\s+)?(?:public\.)?"?paper_ledger_fence\b/gi;
function spans(source){
  const fundingStart=source.indexOf('export async function recordFunding('),fundingEnd=source.indexOf('export const ledgerMethods=');
  const executionStart=source.indexOf('  async recordExecution('),executionEnd=source.indexOf('\n  async ',executionStart+1);
  assert.ok(fundingStart>=0&&fundingEnd>fundingStart&&executionStart>0&&executionEnd>executionStart,'ledger.js layout changed: update this guard');
  return [['recordFunding',fundingStart,fundingEnd],['recordExecution',executionStart,executionEnd]];
}

test('U4 every Paper ledger writer in src/postgres is recordFunding or recordExecution, after its fence call',()=>{
  const files=fs.readdirSync(ROOT).filter(name=>/\.(js|mjs|sql)$/.test(name));
  assert.ok(files.includes('ledger.js')&&files.length>20,'src/postgres listing');
  const found=[];
  for(const name of files){
    const source=fs.readFileSync(path.join(ROOT,name),'utf8');
    for(const match of source.matchAll(WRITER))found.push({name,table:match[1].toLowerCase(),index:match.index,source});
    // Only the shared helper writes the fence, so no caller can take it in another order or unqualified.
    const fenceWriters=[...source.matchAll(FENCE_WRITER)];
    assert.equal(fenceWriters.length,name==='ledger.js'?1:0,name+': fence writers');
  }
  assert.ok(found.length>=3,'the guard still sees the known writers: '+found.map(f=>f.name+':'+f.table).join(', '));
  const ledger=fs.readFileSync(path.join(ROOT,'ledger.js'),'utf8'),owners=spans(ledger);
  for(const writer of found){
    assert.equal(writer.name,'ledger.js',`${writer.name} writes ${writer.table}: add the Bot lock and the F4 fence, then list it here`);
    const owner=owners.find(([,start,end])=>writer.index>start&&writer.index<end);
    assert.ok(owner,`ledger.js offset ${writer.index} writes ${writer.table} outside recordFunding and recordExecution`);
    const fenceCall=ledger.indexOf('bumpPaperLedgerFence(',owner[1]);
    assert.ok(fenceCall>owner[1]&&fenceCall<writer.index,`${owner[0]} writes ${writer.table} before its fence call`);
  }
  assert.deepEqual([...new Set(found.map(f=>f.table))].sort(),['ledger_positions','paper_cash_journal','paper_funding']);
});
