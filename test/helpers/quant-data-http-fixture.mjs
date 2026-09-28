import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {bindQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {hashPassword} from '../../src/security.js';
import {config} from '../../src/config.js';
import {httpClient} from '../helpers.mjs';

/** Disposable HTTP fixture. No market producer or research worker runs here. */
export async function quantDataHttpFixture(connection,{enabled=true}={}) {
  const admin=new PostgresDatabase({connectionString:connection});
  const name='quant_data_http_'+randomUUID().replaceAll('-','');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'quant-data-http-'));
  let db,server,exited=false,closed=false;
  async function close(){
    if(closed)return;closed=true;
    if(server&&!exited){const done=once(server,'exit');server.kill('SIGTERM');await done;}
    await db?.close();
    await admin.query('DROP DATABASE IF EXISTS '+name);await admin.close();
    await fs.rm(directory,{recursive:true,force:true});
  }
  try {
    await admin.query('CREATE DATABASE '+name);
    const target=new URL(connection);target.pathname='/'+name;
    db=new PostgresDatabase({connectionString:target.toString()});await db.migrate();
    for(const file of ['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql','quant-storage-schema.sql'])
      await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
    await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
    const root=path.join(directory,'datasets');
    await db.transaction(()=>bindQuantStorage(db,root));
    const limits=path.join(directory,'limits.json');
    await fs.writeFile(limits,JSON.stringify({diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0}));
    const store=new Store(db),password=randomUUID()+'-fixture';
    const user=await store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword(password),role:'ADMIN'});
    const foreign=await store.createUser({email:randomUUID()+'@example.test',passwordHash:'NO_LOGIN',role:'ADMIN'});
    for(const actor of [user,foreign])await store.setRisk(actor.id,{...structuredClone(config.defaultRisk),paperTrading:true});
    const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
    const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    const base='http://127.0.0.1:'+port;
    server=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,
      DATABASE_URL:target.toString(),HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:base,SMTP_HOST:'',PAPER_TRADING:'true',
      PINE_BRIDGE_ENABLED:'1',PINE_BRIDGE_ENV:'staging',QUANT_RESEARCH_ENABLED:enabled?'1':'0',
      QUANT_RESEARCH_FOUNDATION_ENABLED:enabled?'1':'0',QUANT_RESEARCH_DATASET_ROOT:root,QUANT_STORAGE_LIMITS_FILE:limits}});
    let output='';server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);server.on('exit',()=>exited=true);
    let ready=false;
    for(let i=0;i<100&&!exited;i++){try{ready=(await fetch(base+'/api/auth/config')).ok;}catch{}if(ready)break;await delay(50);}
    if(!ready)throw new Error('HTTP fixture startup failed: '+output.slice(-2000));
    return {db,store,user,foreign,password,base,request:httpClient(base),close};
  }catch(error){await close();throw error;}
}
