import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PassThrough} from 'node:stream';
import {Store} from '../src/database.js';
import {Auth,SecurityMailWorker} from '../src/auth.js';
import {readJson} from '../src/http-safety.js';
import {config} from '../src/config.js';
import {hashToken,hashPassword,verifyPassword,encryptJson,decryptJson,encryptionKeys} from '../src/security.js';
import {totp,newTotpSecret,verifyTotp} from '../src/mfa.js';
import {rotateEncryptionKey} from '../scripts/rotate-encryption-key.mjs';
import {rehearsePhase1} from '../scripts/rehearse-phase1.mjs';
import {acquireProcessLock} from '../src/process-lock.js';
import {authFixture,enroll,removeAuthSchema} from './helpers.mjs';

const password='temporary-test-password';
const loginBody={email:'admin@example.test',password};
async function adminLogin(f){const login=await f.request('/api/auth/login','POST',loginBody);assert.equal(login.status,200);const mfa=await enroll(f.request,login.session);return {...mfa,session:login.session,id:login.body.user.id};}
function localStore(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'robot-security-')),dbPath=path.join(dir,'db.sqlite'),store=new Store(dbPath);t.after(()=>{try{store.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});return {store,dbPath,dir};}

test('TOTP matches RFC 6238 vectors and rejects replay, malformed and out-of-window codes',()=>{
  const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for(const [seconds,expected] of [[59,'94287082'],[1111111109,'07081804'],[1111111111,'14050471'],[1234567890,'89005924'],[2000000000,'69279037'],[20000000000,'65353130']])assert.equal(totp(secret,Math.floor(seconds/30),8),expected);
  const now=600000,step=20,code=totp(secret,step);
  assert.equal(verifyTotp(secret,code,-1,now),step);assert.equal(verifyTotp(secret,code,step,now),null);
  assert.equal(verifyTotp(secret,'00000',-1,now),null);assert.equal(verifyTotp(secret,totp(secret,step-2),-1,now),null);
  assert.match(newTotpSecret(),/^[A-Z2-7]{32}$/);
});

test('cookies replace bearer tokens; CSRF, Origin, admin MFA and session expiry fail closed',async t=>{
  const f=await authFixture(t),r=f.request,login=await r('/api/auth/login','POST',loginBody),s=login.session;
  assert.equal(login.body.token,undefined);assert.ok(login.cookies.some(c=>/HttpOnly; SameSite=Strict/.test(c)));
  assert.equal((await r('/api/me','GET',undefined,{}, {authorization:'Bearer '+s.cookie.robot_session})).status,401);
  assert.equal((await r('/api/admin/users','GET',undefined,s)).body.code,'MFA_ENROLLMENT_REQUIRED');
  assert.equal((await r('/api/risk','PUT',{killSwitch:true},{cookie:s.cookie,csrf:''})).status,403);
  assert.equal((await r('/api/risk','PUT',{killSwitch:true},s,{origin:'https://evil.test'})).status,403);
  assert.equal((await r('/api/auth/login','POST',loginBody,undefined,{origin:'https://evil.test'})).status,403);
  assert.equal((await r('/api/auth/login','POST',loginBody,undefined,{'content-type':'text/plain'})).status,415);
  assert.equal((await r('/api/auth/session','GET',undefined,s)).body.authenticated,true);
  const mfa=await enroll(r,s);assert.equal((await r('/api/admin/users','GET',undefined,s)).status,200);
  f.db.prepare('UPDATE sessions SET elevated_until=0').run();
  assert.equal((await r('/api/me/webhook-secret','POST',{},s)).body.code,'STEP_UP_REQUIRED');
  f.db.prepare('UPDATE sessions SET last_seen=0').run();assert.equal((await r('/api/me','GET',undefined,s)).status,401);
  const challenge=await r('/api/auth/login','POST',loginBody);
  assert.equal((await r('/api/auth/mfa/login','POST',{code:mfa.recoveryCodes[0]},challenge.session)).status,200);
  f.db.prepare('UPDATE sessions SET expires_at=0').run();assert.equal((await r('/api/me','GET',undefined,challenge.session)).status,401);
  const secure=new Auth({db:{}},{...config,secureCookies:true},()=>{}),headers={};
  secure.writeCookie({getHeader:k=>headers[k],setHeader:(k,v)=>headers[k]=v},secure.cookieName,'a'.repeat(64),60);
  assert.match(headers['set-cookie'][0],/^__Host-robot_session=.*; Path=\/; HttpOnly; SameSite=Strict; Max-Age=60; Secure$/);
  assert.doesNotMatch(headers['set-cookie'][0],/Domain=/);
});

test('MFA login creates no session until verified and recovery codes are single use',async t=>{
  const f=await authFixture(t),r=f.request,admin=await adminLogin(f);
  await r('/api/auth/logout','POST',{},admin.session);
  const challenge=await r('/api/auth/login','POST',loginBody),s=challenge.session;
  assert.equal(challenge.body.mfaRequired,true);assert.equal((await r('/api/me','GET',undefined,s)).status,401);
  assert.equal((await r('/api/auth/mfa/login','POST',{code:totp(admin.secret)},s)).status,401,'Enrollment code cannot be replayed');
  assert.equal((await r('/api/auth/mfa/login','POST',{code:admin.recoveryCodes[0]},s)).status,200);
  assert.equal((await r('/api/auth/mfa/login','POST',{code:admin.recoveryCodes[1]},s)).status,401,'Challenge is consumed');
  const before=s.cookie.robot_session;
  assert.equal((await r('/api/auth/step-up','POST',{password,code:admin.recoveryCodes[0]},s)).status,401);
  assert.equal((await r('/api/auth/step-up','POST',{password,code:admin.recoveryCodes[1]},s)).status,200);
  assert.notEqual(s.cookie.robot_session,before);
  assert.equal((await r('/api/auth/mfa/disable','POST',{password,code:admin.recoveryCodes[2]},s)).status,403);
  const limited=await r('/api/auth/login','POST',loginBody);
  for(let n=0;n<5;n++)assert.equal((await r('/api/auth/mfa/login','POST',{code:'wrong'},limited.session)).status,401);
  assert.equal((await r('/api/auth/mfa/login','POST',{code:admin.recoveryCodes[2]},limited.session)).status,401);
  assert.equal(f.db.prepare('SELECT count(*) n FROM mfa_recovery WHERE code_hash=?').get(hashToken(admin.id+':'+admin.recoveryCodes[2])).n,1);
});

test('every scoped API rejects cross-owner access and support cannot perform administrative writes',async t=>{
  const f=await authFixture(t),r=f.request,admin=await adminLogin(f);
  for(const [email,role] of [['one@example.test','USER'],['two@example.test','USER'],['support@example.test','SUPPORT']]){
    assert.equal((await r('/api/admin/users','POST',{email,password,role},admin.session)).status,201);
  }
  const one=await r('/api/auth/login','POST',{email:'one@example.test',password}),two=await r('/api/auth/login','POST',{email:'two@example.test',password});
  const bot=(await r('/api/bots','POST',{label:'Owner one bot'},one.session)).body;
  const routes=[['GET','/api/me'],['GET','/api/me/webhook-secret'],['PUT','/api/me/webhook-secret'],['POST','/api/me/webhook-secret'],
    ['GET','/api/risk'],['PUT','/api/risk'],['POST','/api/risk/preview'],['GET','/api/brokers'],['PUT','/api/brokers/binance-global'],
    ['GET','/api/signals'],['GET','/api/positions'],['GET','/api/audit'],['GET','/api/analytics/summary'],['GET','/api/analytics/equity-curve'],['GET','/api/analytics/breakdown'],['PUT','/api/analytics/settings'],['POST','/api/me/license/redeem'],['POST','/api/me/password']];
  for(const id of [one.body.user.id,bot.id])for(const [method,route] of routes){const result=await r(route+'?bot_id='+id,method,method==='GET'?undefined:{},two.session);assert.equal(result.status,403,`${method} ${route}`);}
  assert.equal((await r('/api/bots/'+bot.id,'PATCH',{label:'stolen'},two.session)).status,404);
  assert.equal((await r('/api/signals/1/note?bot_id='+bot.id,'PUT',{note:'stolen'},two.session)).status,403);
  for(const route of ['summary','equity-curve','breakdown'])assert.equal((await r('/api/analytics/'+route+'?user_id='+one.body.user.id,'GET',undefined,two.session)).status,403);
  assert.equal((await r('/api/analytics/settings?user_id='+one.body.user.id,'PUT',{},two.session)).status,403);
  assert.equal((await r('/api/admin/users','GET',undefined,two.session)).status,403);
  const support=await r('/api/auth/login','POST',{email:'support@example.test',password});await enroll(r,support.session);
  assert.equal((await r('/api/admin/health','GET',undefined,support.session)).status,200);
  assert.equal((await r('/api/admin/users','GET',undefined,support.session)).status,200);
  for(const [method,route] of [['POST','/api/admin/users'],['POST','/api/admin/licenses'],['GET','/api/admin/licenses'],['POST','/api/admin/global-kill'],['PUT',`/api/admin/users/${one.body.user.id}/status`],['PUT',`/api/admin/users/${one.body.user.id}/role`]])assert.equal((await r(route,method,method==='GET'?undefined:{},support.session)).status,403,route);
  assert.equal((await r('/api/me/webhook-secret?bot_id='+bot.id,'GET',undefined,support.session)).status,403);
  assert.equal((await r('/api/admin/users/'+two.body.user.id+'/role','PUT',{role:'SUPPORT'},admin.session)).status,200);
  assert.equal((await r('/api/me','GET',undefined,two.session)).status,401,'Role changes revoke sessions');
  assert.equal((await r('/api/admin/users/'+admin.id+'/role','PUT',{role:'USER'},admin.session)).status,400);
});

test('password recovery hides account existence, encrypts mail and revokes all sessions without disabling MFA',async t=>{
  const f=await authFixture(t,{smtp:true}),r=f.request,admin=await adminLogin(f),keyring=encryptionKeys('a'.repeat(64));
  const known=await r('/api/auth/forgot-password','POST',{email:loginBody.email}),unknown=await r('/api/auth/forgot-password','POST',{email:'unknown@example.test'});
  assert.deepEqual(known.body,unknown.body);assert.equal(known.status,unknown.status);
  const mail=f.db.prepare('SELECT * FROM security_mail').get();assert.ok(mail);assert.ok(mail.encrypted_body.startsWith('v3.k1.'));
  const message=decryptJson(mail.encrypted_body,keyring,`security-mail:${admin.id}`),token=message.body.match(/#reset=([a-f0-9]{64})/)[1];
  assert.ok(message.body.includes(f.base+'/#reset='));assert.ok(!mail.encrypted_body.includes(token));
  const stored=f.db.prepare('SELECT * FROM password_resets').get();assert.equal(stored.token_hash,hashToken(token));
  assert.equal((await r('/api/auth/reset-password','POST',{token,newPassword:'new-test-password'})).body.code,'MFA_REQUIRED');
  assert.equal((await r('/api/auth/reset-password','POST',{token,newPassword:'new-test-password',code:admin.recoveryCodes[0]})).status,200);
  assert.equal((await r('/api/me','GET',undefined,admin.session)).status,401);
  assert.equal((await r('/api/auth/reset-password','POST',{token,newPassword:'other-test-password',code:admin.recoveryCodes[1]})).status,400);
  const relogin=await r('/api/auth/login','POST',{email:loginBody.email,password:'new-test-password'});assert.equal(relogin.body.mfaRequired,true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM security_mail').get().n,0);
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM audit').all()).includes(token));
});

test('expired reset tokens fail, resending invalidates old links and password change invalidates recovery',async t=>{
  const f=await authFixture(t,{smtp:true}),r=f.request;
  const s=(await r('/api/auth/login','POST',loginBody)).session;
  const getToken=()=>{const row=f.db.prepare('SELECT * FROM security_mail').get();return decryptJson(row.encrypted_body,encryptionKeys('a'.repeat(64)),`security-mail:${row.user_id}`).body.match(/#reset=([a-f0-9]{64})/)[1];};
  await r('/api/auth/forgot-password','POST',loginBody);const old=getToken();
  await r('/api/auth/forgot-password','POST',loginBody);const fresh=getToken();assert.notEqual(old,fresh);
  assert.equal((await r('/api/auth/reset-password','POST',{token:old,newPassword:'new-test-password'})).status,400);
  f.db.prepare('UPDATE password_resets SET expires_at=0').run();
  assert.equal((await r('/api/auth/reset-password','POST',{token:fresh,newPassword:'new-test-password'})).status,400);
  assert.equal((await r('/api/me','GET',undefined,s)).status,200);
  const mfa=await enroll(r,s);
  await r('/api/auth/forgot-password','POST',loginBody);const pending=getToken();
  const challenge=await r('/api/auth/login','POST',loginBody);
  assert.equal((await r('/api/me/password','POST',{currentPassword:password,newPassword:'changed-test-password'},s)).status,200);
  assert.equal((await r('/api/auth/reset-password','POST',{token:pending,newPassword:'another-test-password',code:mfa.recoveryCodes[0]})).status,400);
  assert.equal((await r('/api/auth/mfa/login','POST',{code:mfa.recoveryCodes[0]},challenge.session)).status,401);
  assert.equal((await r('/api/me','GET',undefined,s)).status,401);
});

test('MFA challenge cannot survive revocation or expiry while its request body is streaming',async t=>{
  const {store}=localStore(t),user=store.createUser({email:'slow@example.test',passwordHash:'unused'}),auth=new Auth(store,config,()=>{});
  let consumed=false;auth.consumeFactor=()=>{consumed=true;return true;};
  for(const revoke of [()=>store.revokeSessions(user.id),()=>store.db.prepare('UPDATE auth_challenges SET expires_at=0').run()]){
    const token='f'.repeat(64);
    store.db.prepare('DELETE FROM auth_challenges').run();
    store.db.prepare('INSERT INTO auth_challenges(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token),user.id,Date.now()+60000);
    const req=new PassThrough();req.method='POST';req.headers={cookie:`${auth.challengeName}=${token}`};req.socket={remoteAddress:'127.0.0.1'};
    const result=auth.routes(req,{},new URL('http://localhost/api/auth/mfa/login'));
    revoke();req.end(JSON.stringify({code:'test'}));
    await assert.rejects(result,/Verification expired/);assert.equal(consumed,false);
  }
  const token='e'.repeat(64);store.createSession(user.id,token,Date.now()+60000);
  const req=new PassThrough();req.method='POST';req.headers={cookie:`${auth.cookieName}=${token}`,'x-csrf-token':hashToken('csrf:'+token)};
  auth.require(req);const result=readJson(req);store.revokeSessions(user.id);req.end('{}');
  await assert.rejects(result,/Unauthorized/);
});

test('encrypted recovery outbox retries, delivers and removes token material',async t=>{
  const {store}=localStore(t),user=store.createUser({email:'mail@example.test',passwordHash:'unused'}),keys=encryptionKeys('a'.repeat(64));
  store.db.prepare('INSERT INTO security_mail(user_id,encrypted_body,expires_at) VALUES(?,?,?)').run(user.id,encryptJson({subject:'Recovery',body:'test-link'},keys,`security-mail:${user.id}`),Date.now()+60000);
  let ok=false,captured;
  const worker=new SecurityMailWorker(store,{keyring:keys},{send:async(...args)=>{captured=args;return ok;}});
  await worker.tick();assert.equal(store.db.prepare('SELECT attempts FROM security_mail').get().attempts,1);
  ok=true;store.db.prepare('UPDATE security_mail SET next_attempt=0').run();await worker.tick();
  assert.deepEqual(captured,['mail@example.test','Recovery','test-link']);assert.equal(store.db.prepare('SELECT count(*) n FROM security_mail').get().n,0);
});

test('schema 9 migration preserves trading data and secrets while revoking legacy sessions',async t=>{
  const {store,dbPath}=localStore(t),user=store.createUser({email:'legacy@example.test',passwordHash:await hashPassword(password)});
  store.setWebhookSecret(user.id,'a'.repeat(64),encryptJson({secret:'a'.repeat(64)},'master',`webhook:${user.id}`));
  store.createSession(user.id,'old-session',Date.now()+100000);
  const before=store.webhookSecret(user.id);removeAuthSchema(store.db);store.db.exec('PRAGMA user_version=9');store.close();
  const rehearsal=rehearsePhase1(dbPath,path.join(path.dirname(dbPath),'phase1-copy.db'));
  assert.equal(rehearsal.legacySessionsRevoked,1);assert.equal(rehearsal.preservedTables.users,1);
  const original=new DatabaseSync(dbPath,{readOnly:true});
  assert.equal(original.prepare('PRAGMA user_version').get().user_version,9);assert.equal(original.prepare('SELECT count(*) n FROM sessions').get().n,1);original.close();
  const next=new Store(dbPath);
  try{assert.equal(next.db.prepare('PRAGMA user_version').get().user_version,10);assert.deepEqual(next.webhookSecret(user.id),before);assert.equal(next.session('old-session'),undefined);assert.ok(await verifyPassword(password,next.userByEmail(user.email).password_hash));assert.equal(next.db.prepare('PRAGMA foreign_key_check').all().length,0);}finally{next.close();}
});

test('key rotation backs up, preserves plaintext/tenant binding, refuses active process and rolls back bad records',t=>{
  const {store,dbPath,dir}=localStore(t),user=store.createUser({email:'rotate@example.test',passwordHash:'unused'}),old=encryptionKeys('a'.repeat(64)),next=encryptionKeys('b'.repeat(64),'k2');
  store.setWebhookSecret(user.id,'c'.repeat(64),encryptJson({secret:'c'.repeat(64)},old,`webhook:${user.id}`));
  store.setCredential(user.id,'binance-global',encryptJson({apiKey:'test-only'},old,`${user.id}:binance-global`));
  const args={databasePath:dbPath,backupPath:path.join(dir,'backup.db'),oldKeys:old,newKey:'b'.repeat(64),newId:'k2'};
  const release=acquireProcessLock(dbPath);assert.throws(()=>rotateEncryptionKey(args),/Another process/);release();
  const result=rotateEncryptionKey(args);assert.equal(result.records,2);
  const row=store.webhookSecret(user.id);assert.equal(decryptJson(row.webhook_secret_encrypted,next,`webhook:${user.id}`).secret,'c'.repeat(64));
  assert.throws(()=>decryptJson(row.webhook_secret_encrypted,next,'webhook:other-user'));
  const backup=new DatabaseSync(args.backupPath,{readOnly:true});assert.ok(backup.prepare('SELECT webhook_secret_encrypted FROM users').get().webhook_secret_encrypted.startsWith('v3.k1.'));backup.close();
  store.setCredential(user.id,'binance-th','invalid-ciphertext');
  assert.throws(()=>rotateEncryptionKey({...args,backupPath:path.join(dir,'failed.db'),oldKeys:next,newKey:'d'.repeat(64),newId:'k3'}));
  assert.equal(store.credential(user.id,'binance-global').encrypted_data.split('.')[1],'k2');
});
