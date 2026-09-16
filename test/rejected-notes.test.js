import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/database.js';

test('rejected notes preserve system reasons and enforce ownership',()=>{
  const store=new Store(':memory:');
  try{
    const a=store.createUser({email:'a@test.local',passwordHash:'unused'});
    const b=store.createUser({email:'b@test.local',passwordHash:'unused'});
    store.enqueue(a.id,{tradeId:'rejected',timestamp:Date.now(),broker:'binance-global',symbol:'BTCUSDT',event:'BUY',side:'BUY'});
    const row=store.listSignals(a.id)[0];
    assert.throws(()=>store.setRejectedNote(a,row.id,'note'),/Rejected/);
    store.complete(row.id,'REJECTED',{error:'Signal is stale'});
    assert.equal(store.setRejectedNote(b,row.id,'not allowed'),false);
    assert.throws(()=>store.setRejectedNote(a,row.id,'x'.repeat(2001)),/2000/);
    assert.equal(store.setRejectedNote(a,row.id,' Reviewed timestamp '),true);
    assert.equal(store.listSignals(a.id)[0].review_note,'Reviewed timestamp');
    assert.equal(store.listSignals(a.id)[0].error_message,'Signal is stale');
    assert.equal(store.setRejectedNote({...b,role:'ADMIN'},row.id,''),true);
    assert.equal(store.listSignals(a.id)[0].review_note,'');
    assert.equal(store.listAudit(a.id)[0].event,'signal.note.updated');
  }finally{store.close();}
});
