import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
import {EventEmitter} from 'node:events';

const source=fs.readFileSync(new URL('../src/postgres/db.js',import.meta.url),'utf8');

// Execute the real class with inert pools and a recorded process.exit (the stub exists only
// inside this sandbox). No database or service starts.
function databaseClass(exits){
  const context={pg:{Pool:class{on(){}},types:{}},AsyncLocalStorage,fs:{},
    PAPER_LEDGER_FENCE_REPLICATION_ROLE:'PAPER_LEDGER_FENCE_REPLICATION_ROLE',
    process:{env:{},exit:code=>exits.push(code)},console:{error(){}},ensurePaperLedgerFence(){}};
  const adapted=source.replaceAll('import.meta.url',JSON.stringify('file:///synthetic/'))
    .replace(/^import .*;\r?\n/gm,'')
    .replace('export class PostgresDatabase','class PostgresDatabase')
    .replace('export const transaction=','const transaction=');
  vm.runInNewContext(adapted+'\nglobalThis.DB=PostgresDatabase;',context,{timeout:1000});
  return context.DB;
}

// The fake release adds no pool listener, the worst case for an unhandled 'error' event.
async function lockedDatabase(onUnlock=()=>{}){
  const exits=[],Database=databaseClass(exits),client=new EventEmitter(),releases=[],sql=[];
  client.release=reason=>releases.push(reason);
  client.query=async text=>{sql.push(text);
    if(text.includes('current_setting'))return {rows:[{role:'origin'}]};
    if(text.includes('pg_try_advisory_lock_shared'))return {rows:[{ok:true}]};
    if(text.includes('pg_advisory_unlock_shared')){onUnlock(client);return {rows:[{unlocked:true}]};}
    throw new Error('Unexpected SQL '+text);};
  const db=new Database({connectionString:'synthetic',max:2});
  db.pool={options:{max:2},connect:async()=>client,end:async()=>{}};db.limitPool={end:async()=>{}};
  await db.runtimeLock();assert.equal(db.runtimeClient,client);
  return {db,client,exits,releases,sql};
}
const terminated=()=>Object.assign(new Error('terminating connection due to administrator command'),{code:'57P01',severity:'FATAL'});

test('runtime lock loss before close still stops the process',async()=>{
  const {client,exits,releases}=await lockedDatabase();
  client.emit('error',terminated());
  assert.deepEqual(exits,[1]);assert.deepEqual(releases,[]);
});

test('runtime lock loss during the close unlock still stops the process',async()=>{
  const {db,exits}=await lockedDatabase(client=>client.emit('error',terminated()));
  await db.close();
  assert.deepEqual(exits,[1],'The lock is still held until the unlock query returns');
});

test('termination of the released runtime client after close is not lock loss',async()=>{
  const {db,client,exits,releases,sql}=await lockedDatabase();
  await db.close();
  assert.ok(sql.at(-1).includes('pg_advisory_unlock_shared'));assert.deepEqual(releases,[undefined]);assert.equal(db.runtimeClient,null);
  assert.ok(client.listenerCount('error')>0,'An inert listener keeps the event handled');
  assert.doesNotThrow(()=>client.emit('error',terminated()));
  assert.doesNotThrow(()=>client.emit('error',Object.assign(new Error('read ECONNRESET'),{code:'ECONNRESET'})));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(exits,[]);
});

test('a later query on the reused released client still rejects and releases on FATAL',async()=>{
  const {db,client,exits,releases}=await lockedDatabase();
  await db.close();
  const base=client.query;client.query=text=>text==='SELECT hang'?new Promise(()=>{}):base(text);
  releases.length=0;
  const pending=db.query('SELECT hang');
  const failure=terminated();
  await new Promise(resolve=>setImmediate(resolve));
  client.emit('error',failure);
  await assert.rejects(pending,{code:'57P01'});
  assert.deepEqual(exits,[]);assert.deepEqual(releases,[failure]);
});

test('a failed unlock keeps the lock-lost handler attached',async()=>{
  const {db,client,exits,releases}=await lockedDatabase();
  const base=client.query;
  client.query=text=>text.includes('pg_advisory_unlock_shared')?Promise.reject(terminated()):base(text);
  await assert.rejects(db.close(),{code:'57P01'});
  assert.deepEqual(releases,[]);
  client.emit('error',terminated());
  assert.deepEqual(exits,[1]);
});
