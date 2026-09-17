import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {encryptJson,decryptJson,encryptionKeys} from '../../src/security.js';
import {backupPostgres,postgresToolEnvironment} from '../../scripts/backup-postgres.mjs';
import {rotatePostgresKey} from '../../scripts/rotate-postgres-key.mjs';
import {resetPostgresPassword} from '../../scripts/reset-postgres-password.mjs';

test('pg_dump restore preserves every row; offline key rotation backs up and rolls back unreadable data',async t=>{
  assert.ok(process.env.TEST_DATABASE_URL,'Real PostgreSQL and pg_dump/pg_restore are required');
  const admin=new PostgresDatabase({connectionString:process.env.TEST_DATABASE_URL}),suffix=randomUUID().replaceAll('-','');
  const names=['robot_phase2_ops_'+suffix,'robot_phase2_restore_'+suffix],dbs=[],role='robot_phase2_role_'+suffix;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'robot-pg-ops-'));
  t.after(async()=>{await Promise.all(dbs.map(db=>db.close()));for(const name of names)await admin.query('DROP DATABASE IF EXISTS '+name);await admin.query('DROP ROLE IF EXISTS '+role);await admin.close();fs.rmSync(dir,{recursive:true,force:true});});
  for(const name of names){await admin.query('CREATE DATABASE '+name);const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;dbs.push(new PostgresDatabase({connectionString:url.toString()}));}
  const [db,restored]=dbs;await db.migrate();const store=new Store(db);
  const user=await store.createUser({email:'restore@example.test',passwordHash:'unchanged-hash',role:'ADMIN'});
  const old=encryptionKeys('a'.repeat(64),'original'),next=encryptionKeys('b'.repeat(64),'rotated');
  await store.setWebhookSecret(user.id,'fixture',encryptJson({secret:'fixture'},old,'webhook:'+user.id));
  await store.setCredential(user.id,'binance-global',encryptJson({apiKey:'fixture'},old,user.id+':binance-global'));
  await db.prepare('INSERT INTO user_security(user_id,mfa_secret) VALUES(?,?)').run(user.id,encryptJson({secret:'fixture'},old,'mfa:'+user.id));
  await db.prepare('INSERT INTO security_mail(user_id,encrypted_body,expires_at) VALUES(?,?,?)').run(user.id,encryptJson({body:'fixture'},old,'security-mail:'+user.id),Date.now()+60000);
  const snapshot=async target=>{
    const tables=(await target.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename),data={};
    for(const table of tables){assert.match(table,/^[a-z_]+$/);data[table]=(await target.query('SELECT * FROM '+table)).rows.map(row=>JSON.stringify(Object.fromEntries(Object.entries(row).sort()))).sort();}
    return createHash('sha256').update(JSON.stringify(data)).digest('hex');
  };
  const before=await snapshot(db),backup=await backupPostgres(path.join(dir,'verified.dump'),{connectionString:db.pool.options.connectionString});assert.ok(backup.bytes>0);
  const env=postgresToolEnvironment(restored.pool.options.connectionString);
  const status=await new Promise((resolve,reject)=>{const child=spawn(process.env.PG_RESTORE_PATH||'pg_restore',['--exit-on-error','--no-owner','--dbname',env.PGDATABASE,backup.path],{env,stdio:'ignore',windowsHide:true});child.on('error',reject);child.on('exit',resolve);});
  assert.equal(status,0);assert.equal(await snapshot(restored),before);
  assert.equal(decryptJson((await new Store(restored).webhookSecret(user.id)).webhook_secret_encrypted,old,'webhook:'+user.id).secret,'fixture');
  const rotated=await rotatePostgresKey({db,backupPath:path.join(dir,'pre-rotation.dump'),oldKeys:old,newKey:'b'.repeat(64),newId:'rotated'});assert.equal(rotated.records,4);
  assert.equal(decryptJson((await store.webhookSecret(user.id)).webhook_secret_encrypted,next,'webhook:'+user.id).secret,'fixture');
  await db.prepare('UPDATE security_mail SET encrypted_body=?').run('corrupt');const prior=await snapshot(db);
  await assert.rejects(rotatePostgresKey({db,backupPath:path.join(dir,'failed-rotation.dump'),oldKeys:next,newKey:'c'.repeat(64),newId:'third'}));assert.equal(await snapshot(db),prior);
  const preservedMfa=(await db.prepare('SELECT mfa_secret FROM user_security WHERE user_id=?').get(user.id)).mfa_secret;
  await store.createSession(user.id,'reset-fixture',Date.now()+60000);
  await resetPostgresPassword({db,email:user.email,password:'changed-only-in-fixture'});
  assert.equal((await db.prepare('SELECT count(*) n FROM sessions').get()).n,0);
  assert.equal((await db.prepare('SELECT mfa_secret FROM user_security WHERE user_id=?').get(user.id)).mfa_secret,preservedMfa);
  await admin.query('CREATE ROLE '+role+' NOSUPERUSER NOCREATEDB NOCREATEROLE');
  await db.query(fs.readFileSync(new URL('../../scripts/grant-postgres-runtime.sql',import.meta.url),'utf8').replaceAll('robot_app',role));
  await db.transaction(async()=>{await db.query('SET LOCAL ROLE '+role);await db.verifySchema();await store.audit(user.id,'role.fixture',null,{});assert.equal((await store.userById(user.id)).id,user.id);});
  await assert.rejects(db.transaction(async()=>{await db.query('SET LOCAL ROLE '+role);await db.query('CREATE TABLE forbidden_fixture(id int)');}),{code:'42501'});
});
