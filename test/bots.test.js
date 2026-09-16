import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/database.js';
import {Worker} from '../src/worker.js';
import {config} from '../src/config.js';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'robot-bots-')),store=new Store(path.join(dir,'test.db'));
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const owner=store.createUser({email:'owner@test.local',passwordHash:'unused',role:'ADMIN'});
  return {store,owner};
}
test('bot quota is four children plus main; owners and slots are constrained',t=>{
  const {store,owner}=fixture(t);
  const bots=[1,2,3,4].map(index=>store.createBot(owner.id,`Bot ${index}`,config.defaultRisk));
  assert.deepEqual(store.listBots(owner.id).map(bot=>bot.bot_slot_index),[1,2,3,4,5]);
  assert.throws(()=>store.createBot(owner.id,'Extra',config.defaultRisk),/Maximum 5/);
  assert.throws(()=>store.createBot(bots[0].id,'Nested',config.defaultRisk),/Main account/);
  assert.equal(store.listUsers().length,1);
  const other=store.createUser({email:'other@test.local',passwordHash:'unused'});
  assert.equal(store.ownsBot(other.id,bots[0].id),false);
  assert.equal(store.ownsBot(owner.id,bots[0].id),true);
  assert.throws(()=>store.createSession(bots[0].id,'child-session',Date.now()+10000),/Main account session/);
});
test('bot balances, positions, duplicate IDs and loss streaks stay isolated',async t=>{
  const {store,owner}=fixture(t),a=store.createBot(owner.id,'A',config.defaultRisk),b=store.createBot(owner.id,'B',config.defaultRisk);
  const signal={tradeId:'shared-id',broker:'binance-global',symbol:'BTCUSDT',event:'BUY',side:'BUY',orderType:'MARKET',timestamp:Date.now(),riskMode:'QUANTITY',quantity:1,referencePrice:100,stopLoss:90,leverage:1,newsRisk:false,volatilityPercent:0};
  const worker=new Worker({store,config});
  store.setRisk(a.id,{...config.defaultRisk,equities:{'binance-global':1000},balances:{'binance-global':1000}});
  store.setRisk(b.id,{...config.defaultRisk,equities:{'binance-global':10},balances:{'binance-global':10}});
  assert.equal(store.enqueue(a.id,signal),true);await worker.tick();
  assert.equal(store.enqueue(b.id,signal),true);await worker.tick();
  assert.equal(store.listSignals(a.id)[0].status,'FILLED');assert.equal(store.listSignals(b.id)[0].status,'REJECTED');
  assert.equal(store.listPositions(a.id)[0].quantity,1);assert.equal(store.listPositions(b.id).length,0);assert.equal(store.listPositions(owner.id).length,0);
  store.enqueue(a.id,{...signal,tradeId:'exit',side:'SELL',event:'SL',reduceOnly:true,referencePrice:90});await worker.tick();
  assert.equal(store.dailyAccounts(a.id)[0].loss_streak,1);assert.equal(store.dailyAccounts(b.id).length,0);
  store.setUserStatus(owner.id,'SUSPENDED');store.enqueue(a.id,{...signal,tradeId:'suspended'});await worker.tick();
  assert.match(store.listSignals(a.id)[0].error_message,/Main account is suspended/);
});
