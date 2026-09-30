import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {Store} from '../../src/postgres/store.js';
import {bindQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {validateQuantCapacityPolicy} from '../../src/postgres/quant-capacity-policy.js';
import {profileV2Fixture} from './profile-v2-fixture.js';
import {hashPassword} from '../../src/security.js';
import {httpClient} from '../helpers.mjs';

/** Actual unchanged application, auth and SERIALIZABLE response buffering.
 * No market data, worker or evidence producer. Enabled Windows cases substitute
 * the policy-file bootstrap loader. Positive cases may explicitly substitute the
 * supported synthetic source identity; this is never private-source parity.
 */
export async function quantPreflightHttpFixture(connection,{mode='disabled',environment={},
  missingPreflightSchema=false,missingEnrollmentSchema=false,expectStartupFailure=false,
  capacityPolicy=null,syntheticSourceHash=null}={}){
  if(!connection||!['127.0.0.1','localhost','[::1]'].includes(new URL(connection).hostname))
    throw Error('Root-assigned loopback PostgreSQL required');
  if(!['disabled','native-enabled','test-policy'].includes(mode))throw Error('Unknown test fixture mode');
  const admin=new PostgresDatabase({connectionString:connection}),name='preflight_http_'+randomUUID().replaceAll('-','');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'preflight-http-'));
  let db,server,exitPromise,exited=false,closed=false,output='',exitCode;
  async function close(){
    if(closed)return;closed=true;
    if(server&&!exited){server.kill('SIGTERM');await Promise.race([exitPromise,delay(5000).then(()=>{
      if(!exited)server.kill('SIGKILL');})]);await exitPromise;}
    await db?.close();await admin.query('DROP DATABASE IF EXISTS '+name);await admin.close();
    await fs.rm(directory,{recursive:true,force:true});
  }
  try{
    await admin.query('CREATE DATABASE '+name);
    const target=new URL(connection);target.pathname='/'+name;
    db=new PostgresDatabase({connectionString:target.toString()});await db.migrate();
    const schemas=['pine-bridge-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql',
      'quant-research-foundation-schema.sql','quant-storage-schema.sql','quant-io-ledger-schema.sql','quant-io-runtime-schema.sql'];
    if(!missingPreflightSchema)schemas.push('quant-preflight-schema.sql');
    if(!missingEnrollmentSchema)schemas.push('quant-profile-enrollment-schema.sql');
    for(const file of schemas)await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
    await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
    const root=path.join(directory,'datasets');await db.transaction(()=>bindQuantStorage(db,root));
    const limits=path.join(directory,'limits.json');
    await fs.writeFile(limits,JSON.stringify({diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0}));
    const policy=structuredClone(capacityPolicy??profileV2Fixture().policy);policy.environment='staging';
    policy.terminal??={version:'quant-io-terminal-policy-v1',runtime_max_ms:30000,terminal_drain_ms:0,tail_margin_ms:5000};
    validateQuantCapacityPolicy(policy);
    const policyFile=path.join(directory,'policy.json');await fs.writeFile(policyFile,JSON.stringify(policy));
    const store=new Store(db),password=randomUUID()+'-fixture';
    async function account({parentId,role='ADMIN'}={}){
      const user=await store.createUser({email:randomUUID()+'@example.test',passwordHash:await hashPassword(password),role});
      if(parentId)await db.query('UPDATE users SET parent_user_id=$2,bot_slot_index=2 WHERE id=$1',[user.id,parentId]);
      return user;
    }
    const owner=await account(),foreign=await account(),sibling=await account({parentId:owner.id,role:'USER'});
    const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
    const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    const base='http://127.0.0.1:'+port;
    const execArgv=mode==='test-policy'?['--import',new URL('./quant-preflight-policy-loader.mjs',import.meta.url).href]:[];
    server=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,execArgv,env:{...process.env,
      // Clear inherited feature/startup inputs before choosing each isolated case.
      NODE_OPTIONS:'',NODE_ENV:'test',DATABASE_URL:target.toString(),HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:base,
      SMTP_HOST:'',PAPER_TRADING:'true',PINE_BRIDGE_ENABLED:'1',PINE_CAPTURE_ENABLED:'0',PINE_BRIDGE_ENV:'staging',
      QUANT_RESEARCH_ENABLED:'1',QUANT_RESEARCH_FOUNDATION_ENABLED:'1',QUANT_PROFILE_V2_ENABLED:'0',
      QUANT_PROFILE_V2_ENROLLMENT_ENABLED:'0',QUANT_PREFLIGHT_ENABLED:mode==='disabled'?'0':'1',
      QUANT_RESEARCH_DATASET_ROOT:root,QUANT_STORAGE_LIMITS_FILE:limits,
      QUANT_CAPACITY_POLICY_FILE:mode==='disabled'?path.join(directory,'must-not-read-policy.json'):policyFile,
      PF2_HTTP_SYNTHETIC_SOURCE_HASH:syntheticSourceHash??'',
      ...environment}});
    server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);
    exitPromise=new Promise(resolve=>server.once('exit',code=>{exited=true;exitCode=code;resolve(code);}));
    let ready=false;
    for(let i=0;i<160&&!exited;i++){
      try{ready=(await fetch(base+'/api/auth/config')).ok;}catch{}
      if(ready)break;await delay(50);
    }
    if(expectStartupFailure){
      if(ready||!exited)throw Error('Expected bounded startup refusal before listener');
    }else if(!ready)throw Error('PF-2 HTTP fixture startup failed: '+output.slice(-1200));
    const request=httpClient(base);
    async function login(user){const answer=await request('/api/auth/login','POST',{email:user.email,password});
      if(answer.status!==200)throw Error('PF-2 fixture login failed');return answer.session;}
    return {db,store,owner,foreign,sibling,request,login,root,base,close,policy,
      startup:{ready,exited,exitCode,output},listing:()=>fs.readdir(root,{recursive:true})};
  }catch(error){await close();throw error;}
}
