import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/database.js';
import {encryptJson,decryptJson} from '../src/security.js';

test('legacy webhook recovery preserves URL, binds encryption to owner and rotation clears stale ciphertext',()=>{
  const store=new Store(':memory:'),secret='a'.repeat(64),key='b'.repeat(64);
  try{
    const u=store.createUser({email:'owner@test.local',passwordHash:'unused'});
    store.setWebhookSecret(u.id,secret);
    assert.equal(store.webhookSecret(u.id).webhook_secret_encrypted,null);
    const encrypted=encryptJson({secret},key,'webhook:'+u.id);
    assert.equal(encrypted.includes(secret),false);
    assert.equal(store.rememberWebhookSecret(u.id,'wrong',encrypted),false);
    assert.equal(store.rememberWebhookSecret(u.id,secret,encrypted),true);
    assert.equal(store.rememberWebhookSecret(u.id,secret,'overwritten'),false);
    assert.equal(store.userByWebhook(secret).id,u.id);
    assert.equal(decryptJson(store.webhookSecret(u.id).webhook_secret_encrypted,key,'webhook:'+u.id).secret,secret);
    assert.throws(()=>decryptJson(encrypted,key,'webhook:someone-else'));
    assert.equal('webhook_secret_encrypted' in store.userById(u.id),false);
    store.setWebhookSecret(u.id,'c'.repeat(64));
    assert.equal(store.webhookSecret(u.id).webhook_secret_encrypted,null);
    assert.equal(store.userByWebhook(secret),undefined);
  }finally{store.close();}
});
