import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {totp} from '../src/mfa.js';

export function removeAuthSchema(db){
  db.exec(`DROP TABLE security_mail; DROP TABLE security_limits; DROP TABLE password_resets; DROP TABLE auth_challenges;
    DROP TABLE mfa_recovery; DROP TABLE user_security;
    ALTER TABLE sessions DROP COLUMN last_seen; ALTER TABLE sessions DROP COLUMN elevated_until; ALTER TABLE sessions DROP COLUMN mfa_verified;`);
}
export function httpClient(base){
  return async function request(route,method='GET',body,session={cookie:{},csrf:''},headers={}){
    session.cookie??={};
    const response=await fetch(base+route,{method,headers:{'content-type':'application/json',origin:base,
      cookie:Object.entries(session.cookie).map(([k,v])=>`${k}=${v}`).join('; '),
      ...(session.csrf?{'x-csrf-token':session.csrf}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    const cookies=response.headers.getSetCookie();
    for(const item of cookies){const [name,...value]=item.split(';')[0].split('=');session.cookie[name]=value.join('=');}
    const data=await response.json();if(data.csrfToken)session.csrf=data.csrfToken;
    return {status:response.status,body:data,session,cookies,headers:response.headers};
  };
}
export async function authFixture(t,{smtp=false}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'robot-auth-')),dbPath=path.join(dir,'db.sqlite');
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const base=`http://127.0.0.1:${port}`;
  const server=new Worker(new URL('../src/server.js',import.meta.url),{stdout:true,stderr:true,env:{...process.env,
    NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port),DB_PATH:dbPath,PUBLIC_ORIGIN:base,PAPER_TRADING:'true',
    MASTER_ENCRYPTION_KEY:'a'.repeat(64),ENCRYPTION_KEY_ID:'k1',ENCRYPTION_PREVIOUS_KEYS:'{}',
    ADMIN_EMAIL:'admin@example.test',ADMIN_BOOTSTRAP_PASSWORD:'temporary-test-password',SMTP_HOST:smtp?'127.0.0.1':'',SMTP_PORT:'1'}});
  let output='',exited=false;server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);
  const exit=once(server,'exit');server.on('exit',()=>exited=true);
  let db;
  t.after(async()=>{db?.close();if(!exited)await server.terminate();await exit;fs.rmSync(dir,{recursive:true,force:true});});
  let ready=false;
  for(let i=0;i<100&&!exited;i++){try{ready=(await fetch(base+'/healthz')).ok;}catch{}if(ready)break;await delay(50);}
  assert.ok(ready,output);db=new DatabaseSync(dbPath);db.exec('PRAGMA busy_timeout=5000');
  return {request:httpClient(base),base,db,dbPath,dir};
}
export async function enroll(request,session,password='temporary-test-password'){
  const setup=await request('/api/auth/mfa/setup','POST',{password},session);assert.equal(setup.status,200,JSON.stringify(setup.body));
  const enabled=await request('/api/auth/mfa/enable','POST',{code:totp(setup.body.secret)},session);assert.equal(enabled.status,200,JSON.stringify(enabled.body));
  return {secret:setup.body.secret,recoveryCodes:enabled.body.recoveryCodes};
}
