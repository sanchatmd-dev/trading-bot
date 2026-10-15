import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {AsyncLocalStorage} from 'node:async_hooks';
import {EventEmitter} from 'node:events';

const source=fs.readFileSync(new URL('../src/postgres/db.js',import.meta.url),'utf8');

// Execute the real class with inert pools and a recorded process.exit. No database
// or service starts; imports and the unused migration URL are the only adaptations.
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

const coverage={before:0,after:0};
for(let depth=0;depth<9;depth++){
  test(`runtime lock owns a live lease or fails safely at error schedule ${depth}`,async()=>{
    const exits=[],Database=databaseClass(exits),client=new EventEmitter(),releases=[];
    const error=Object.assign(new Error('Synthetic connection loss'),{code:'ECONNRESET'});
    client.release=reason=>releases.push(reason);
    client.query=sql=>{
      assert.equal(releases.length,0,'No SQL may use a discarded lease');
      if(sql==="SELECT pg_catalog.current_setting('session_replication_role') AS role")
        return Promise.resolve({rows:[{role:'origin'}]});
      assert.match(sql,/pg_try_advisory_lock_shared/);
      let remaining=depth;
      const emit=()=>{if(remaining-->0)queueMicrotask(emit);else client.emit('error',error);};
      queueMicrotask(emit);
      return Promise.resolve({rows:[{ok:true}]});
    };
    const db=new Database({connectionString:'synthetic',max:2});
    db.pool={options:{max:2},connect:async()=>client};
    let caught;
    try{await db.runtimeLock();}catch(e){caught=e;}
    await new Promise(resolve=>setImmediate(resolve));
    if(releases.length){
      coverage.before++;
      assert.equal(caught,error,'Preserve the original failure, including the handoff window');
      assert.equal(db.runtimeClient,undefined,'A discarded client must never become the runtime lock');
      assert.equal(releases.length,1);assert.equal(releases[0],error);
      assert.deepEqual(exits,[]);
    }else{
      coverage.after++;
      assert.equal(caught,undefined);assert.equal(db.runtimeClient,client);
      assert.equal(releases.length,0,'The runtime owns the transferred client');
      assert.deepEqual(exits,[1],'Connection loss after transfer must stop the runtime');
    }
  });
}

test("ownership schedules include both sides of transfer",()=>{assert.ok(coverage.before>0);assert.ok(coverage.after>0);});

for(const severity of ['FATAL','PANIC','ERROR']){
  test(`lease handles ${severity} before any socket error`,async()=>{
    const Database=databaseClass([]),first=Object.assign(new Error('Synthetic SQL rejection'),{code:'57P01',severity});
    const events=[],releases=[],socket=Object.assign(new Error('Synthetic later socket error'),{code:'ECONNRESET'});
    const client=()=>{const c=new EventEmitter();let dead=false;c.release=e=>{releases.push(e);dead=!!e;c.on('error',()=>{});};
      c.query=sql=>{events.push(sql);if(dead)return Promise.reject(new Error('Discarded cleanup'));
        if(sql.includes('current_setting'))return Promise.resolve({rows:[{role:'origin'}]});
        if(sql.includes('pg_try_advisory'))return Promise.resolve({rows:[{ok:true}]});
        if(sql==='BAD')return Promise.reject(first);return Promise.resolve({rows:[]});};return c;};
    const held=client(),business=client(),db=new Database({connectionString:'synthetic',max:2});let clients=[held,business];
    db.pool={options:{max:2},connect:async()=>clients.shift()};await db.runtimeLock();
    if(severity==='ERROR'){
      await db.transaction(async()=>{await db.query('SAVEPOINT safe');await assert.rejects(db.query('BAD'),e=>e===first);
        assert.equal(releases.length,0);await db.query('ROLLBACK TO SAVEPOINT safe');await db.query('LATER');});
      assert.ok(events.includes('LATER'));assert.ok(events.includes('COMMIT'));assert.deepEqual(releases,[undefined]);
    }else{
      await assert.rejects(db.transaction(async()=>{await assert.rejects(db.query('BAD'),e=>e===first);
        assert.deepEqual(releases,[first],'Discard before exposing terminal failure');
        await assert.rejects(db.query('LATER'),e=>e===first);business.emit('error',socket);await assert.rejects(db.query('LATER2'),e=>e===first);throw first;}),e=>e===first);
      assert.ok(!events.includes('LATER'));assert.ok(!events.includes('COMMIT'));assert.deepEqual(releases,[first]);
    }
  });
}
