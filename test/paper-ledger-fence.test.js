import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
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

// U4 checks literal SQL in tracked src/postgres and scripts files, including nested files. It is not a SQL parser and
// cannot prove arbitrary dynamically constructed SQL safe. The one known offline import has a site-specific exception.
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const LEDGER='src/postgres/ledger.js',IMPORT='scripts/import-postgres.mjs';
const writerPath=name=>/^(src\/postgres|scripts)\/.*\.(js|mjs|sql)$/.test(name);
const WRITER=/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|COPY)\s+(?:ONLY\s+)?(?:public\.)?"?(paper_funding|paper_cash_journal|ledger_positions)\b/gi;
const FENCE_WRITER=/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|COPY)\s+(?:ONLY\s+)?(?:public\.)?"?paper_ledger_fence\b/gi;
function spans(source){
  const fundingStart=source.indexOf('export async function recordFunding('),fundingEnd=source.indexOf('export const ledgerMethods=');
  const executionStart=source.indexOf('  async recordExecution('),executionEnd=source.indexOf('\n  async ',executionStart+1);
  assert.ok(fundingStart>=0&&fundingEnd>fundingStart&&executionStart>0&&executionEnd>executionStart,'ledger.js layout changed: update this guard');
  return [['recordFunding',fundingStart,fundingEnd],['recordExecution',executionStart,executionEnd]];
}

const IMPORT_UPDATE="await db.query('UPDATE ledger_positions SET cost_basis=ROUND(quantity*avg_price,18)');";
const IMPORT_INSERT="await db.query('INSERT INTO '+name(table)+'('+keys.map(name).join(',')+') VALUES('+keys.map((_,i)=>'$'+(i+1)).join(',')+')',values);";
function importWriterIndex(source){
  // This offline import locks maintenance and all target tables, verifies an empty target, then copies rows.
  // Only its existing dynamic INSERT and cost-basis normalization are exempt; extra sites require review.
  for(const text of [IMPORT_INSERT,IMPORT_UPDATE])
    assert.equal(source.split(text).length-1,1,'import: known writer site changed or duplicated');
  assert.equal([...source.matchAll(/\bINSERT\s+INTO\b/gi)].length,1,'import: extra INSERT writer');
  const dynamic=[...source.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|MERGE\s+INTO|COPY)\s*['"`]\s*\+/gi)];
  assert.equal(dynamic.length,1,'import: extra dynamic writer');
  assert.equal(dynamic[0].index,source.indexOf(IMPORT_INSERT)+"await db.query('".length,'import: unknown dynamic writer');
  const maintenance=source.indexOf('await db.maintenanceLock();');
  const lock=source.indexOf("await db.query('LOCK TABLE '+tables.map(name).join(',')+' IN ACCESS EXCLUSIVE MODE');");
  const empty=source.indexOf("for(const table of tables)assert.equal((await db.query('SELECT count(*) n FROM '+name(table))).rows[0].n,0,'Target must be empty: '+table);");
  assert.ok(maintenance>=0&&maintenance<lock&&lock<empty&&empty<source.indexOf(IMPORT_INSERT)
    &&source.indexOf(IMPORT_INSERT)<source.indexOf(IMPORT_UPDATE),'import: offline lock/empty-target order changed');
  return source.indexOf(IMPORT_UPDATE)+"await db.query('".length;
}
function guardPaperWriters(sources){
  const found=[];
  for(const [name,source] of sources){
    const importIndex=name===IMPORT?importWriterIndex(source):null;
    for(const match of source.matchAll(WRITER)){
      if(name===IMPORT&&match.index===importIndex&&match[1].toLowerCase()==='ledger_positions')continue;
      found.push({name,table:match[1].toLowerCase(),index:match.index});
    }
    // Only the shared helper writes the fence, so no caller can take it in another order or unqualified.
    const fenceWriters=[...source.matchAll(FENCE_WRITER)];
    assert.equal(fenceWriters.length,name===LEDGER?1:0,name+': fence writers');
  }
  assert.ok(found.length>=3,'the guard still sees the known writers: '+found.map(f=>f.name+':'+f.table).join(', '));
  const ledger=sources.get(LEDGER),owners=spans(ledger);
  for(const writer of found){
    assert.equal(writer.name,LEDGER,`${writer.name} writes ${writer.table}: add the Bot lock and the F4 fence, then list it here`);
    const owner=owners.find(([,start,end])=>writer.index>start&&writer.index<end);
    assert.ok(owner,`ledger.js offset ${writer.index} writes ${writer.table} outside recordFunding and recordExecution`);
    const fenceCall=ledger.indexOf('bumpPaperLedgerFence(',owner[1]);
    assert.ok(fenceCall>owner[1]&&fenceCall<writer.index,`${owner[0]} writes ${writer.table} before its fence call`);
  }
  assert.deepEqual([...new Set(found.map(f=>f.table))].sort(),['ledger_positions','paper_cash_journal','paper_funding']);
}
function writerFiles(root){
  if(fs.existsSync(path.join(root,'.git'))){
    // Never fall back on Git failure: checkout diagnostics must remain excluded without opening them.
    return execFileSync('git',['ls-files','-z','--','src/postgres','scripts'],{cwd:root,encoding:'utf8'})
      .split('\0').filter(writerPath);
  }
  // Source exports have no tracked-file inventory. Scan their contents recursively, ignoring all symlinks.
  // Export builders must supply a curated tree; this branch cannot distinguish untracked diagnostics.
  const files=[];
  const visit=name=>{
    let target=root;
    for(const part of name.split('/')){
      target=path.join(target,part);
      if(!fs.existsSync(target)||fs.lstatSync(target).isSymbolicLink())return;
    }
    for(const entry of fs.readdirSync(target,{withFileTypes:true})){
      const child=name+'/'+entry.name;
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory())visit(child);
      else if(entry.isFile()&&writerPath(child))files.push(child);
    }
  };
  visit('src/postgres');visit('scripts');
  return files.sort();
}
function trackedWriterSources(){
  const files=writerFiles(ROOT);
  assert.ok(files.includes(LEDGER)&&files.includes(IMPORT)&&files.length>20,'tracked writer inventory');
  return new Map(files.map(name=>[name,fs.readFileSync(path.join(ROOT,name),'utf8')]));
}
test('U4 source exports inventory nested files without Git and never traverse symlinks',()=>{
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'paper-writer-inventory-'));
  try{
    const root=path.join(temporary,'export'),outside=path.join(temporary,'outside');
    fs.mkdirSync(path.join(root,'src/postgres/nested'),{recursive:true});
    fs.mkdirSync(path.join(root,'scripts/nested'),{recursive:true});fs.mkdirSync(outside);
    for(const name of ['src/postgres/nested/writer.js','scripts/nested/writer.mjs','scripts/nested/writer.sql','scripts/nested/ignored.txt'])
      fs.writeFileSync(path.join(root,name),'not executable source');
    fs.writeFileSync(path.join(outside,'must-not-scan.js'),'not executable source');
    fs.symlinkSync(outside,path.join(root,'scripts/linked'),'junction');
    assert.deepEqual(writerFiles(root),['scripts/nested/writer.mjs','scripts/nested/writer.sql','src/postgres/nested/writer.js']);
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
test('U4 tracked Paper writers take the fence in order, except the known offline import sites',()=>{
  guardPaperWriters(trackedWriterSources());
});
test('U4 rejects new script, nested, import and fence writers without changing repository files',()=>{
  const baseline=trackedWriterSources();
  assert.doesNotThrow(()=>guardPaperWriters(baseline),'known offline import remains allowed');
  for(const name of ['scripts/new-writer.mjs','scripts/nested/new-writer.sql','src/postgres/nested/new-writer.js']){
    assert.ok(writerPath(name),'recursive inventory includes '+name);
    const sources=new Map(baseline);sources.set(name,'UPDATE paper_funding SET cash_delta=0;');
    assert.throws(()=>guardPaperWriters(sources),/writes paper_funding/,name);
  }
  for(const extra of ["\nawait db.query('DELETE FROM ledger_positions');",
    '\n'+IMPORT_UPDATE,'\n'+IMPORT_INSERT,"\nawait db.query('UPDATE '+name(table)+' SET cost_basis=0');"]){
    const sources=new Map(baseline);sources.set(IMPORT,baseline.get(IMPORT)+extra);
    assert.throws(()=>guardPaperWriters(sources),/writes ledger_positions|import:/,'extra import writer');
  }
  for(const name of ['scripts/new-fence-writer.mjs',IMPORT]){
    const sources=new Map(baseline);sources.set(name,(sources.get(name)??'')+'\nDELETE FROM public.paper_ledger_fence;');
    assert.throws(()=>guardPaperWriters(sources),/fence writers/,name);
  }
  const sources=new Map(baseline);
  sources.set(LEDGER,baseline.get(LEDGER).replace('await bumpPaperLedgerFence(store.db,userId);',''));
  assert.notEqual(sources.get(LEDGER),baseline.get(LEDGER),'remove the funding fence call');
  assert.throws(()=>guardPaperWriters(sources),/before its fence call/,'original ordering guard remains active');
});
