import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {installQuantGuards} from './quant-guard-install.mjs';
import {Store} from '../../src/postgres/store.js';
import {bindQuantStorage} from '../../src/postgres/quant-storage-retention.js';
import {hashPassword} from '../../src/security.js';
import {config} from '../../src/config.js';
import {canonical,hash,validateSelection} from '../../src/pine-bridge/source.js';
import {httpClient} from '../helpers.mjs';
import {fixture,source} from './quant-research-fixture.mjs';

const MINUTE=60000;
const EXECUTION_MODEL={version:'paper-close-v1',price_tick:.01,quantity_step:.001,fee_bps:10,slippage_bps:1,risk_percent:1,data_profile:'closed-ohlcv-atr14-v1'};

/**
 * F01-01 owner isolation: disposable real-HTTP fixture around the unchanged src/postgres/server.js (the staging server).
 * Pine Bridge, Pine capture and Quant research (FOUNDATION mode) are all enabled, so every owner-scoped route group answers
 * with its real handler. No worker runs and no market producer runs. Same hash-substitution preload as
 * quant-research-http-fixture.mjs: the repository holds no private Pine source, so only the supported source hash is replaced
 * by the hash of the synthetic source; every other check of the research enqueue runs as in production.
 * `request` counts calls: the API bucket of the server allows 240 requests per minute and source address.
 */
export async function ownerIsolationFixture(connection) {
  const admin=new PostgresDatabase({connectionString:connection});
  const name='owner_isolation_http_'+randomUUID().replaceAll('-','');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'owner-isolation-http-'));
  let db,server,exited=false,closed=false,requests=0;
  async function close() {
    if(closed)return;closed=true;
    if(server&&!exited){const done=once(server,'exit');server.kill('SIGTERM');await done;}
    await db?.close();
    await admin.query('DROP DATABASE IF EXISTS '+name+' WITH (FORCE)');await admin.close();
    await fs.rm(directory,{recursive:true,force:true});
  }
  try {
    await admin.query('CREATE DATABASE '+name);
    const target=new URL(connection);target.pathname='/'+name;
    db=new PostgresDatabase({connectionString:target.toString()});await db.migrate();
    for(const file of ['pine-bridge-schema.sql','pine-capture-schema.sql','quant-research-schema.sql','quant-foundation-schema.sql','quant-research-foundation-schema.sql','quant-storage-schema.sql'])
      await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
    await installQuantGuards(db);
    await db.query("UPDATE quant_research_executor_mode SET mode='FOUNDATION'");
    const root=path.join(directory,'datasets');
    await db.transaction(()=>bindQuantStorage(db,root));
    const limits=path.join(directory,'limits.json');
    await fs.writeFile(limits,JSON.stringify({diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0}));
    const preload=path.join(directory,'preload-source-hash.mjs');
    await fs.writeFile(preload,[
      "import {QuantResearchService} from '"+new URL('../../src/postgres/quant-research.js',import.meta.url).href+"';",
      "Object.defineProperty(QuantResearchService.prototype,'supportedSourceHash',{configurable:true,get:()=>process.env.TEST_SUPPORTED_SOURCE_HASH,set(){}});",''].join('\n'));
    const store=new Store(db);
    const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
    const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    const base='http://127.0.0.1:'+port;
    server=fork(new URL('../../src/postgres/server.js',import.meta.url),[],{silent:true,env:{...process.env,
      NODE_OPTIONS:((process.env.NODE_OPTIONS??'')+' --import='+pathToFileURL(preload).href).trim(),TEST_SUPPORTED_SOURCE_HASH:hash(source),
      DATABASE_URL:target.toString(),HOST:'127.0.0.1',PORT:String(port),PUBLIC_ORIGIN:base,SMTP_HOST:'',PAPER_TRADING:'true',
      PINE_BRIDGE_ENABLED:'1',PINE_BRIDGE_ENV:'staging',PINE_BRIDGE_CAPTURE_ENABLED:'1',QUANT_RESEARCH_ENABLED:'1',
      QUANT_RESEARCH_FOUNDATION_ENABLED:'1',QUANT_RESEARCH_DATASET_ROOT:root,QUANT_STORAGE_LIMITS_FILE:limits}});
    let output='';server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);server.on('exit',()=>exited=true);
    let ready=false;
    for(let i=0;i<100&&!exited;i++){try{ready=(await fetch(base+'/api/auth/config')).ok;}catch{}if(ready)break;await delay(50);}
    if(!ready)throw new Error('HTTP fixture startup failed: '+output.slice(-2000));
    const send=httpClient(base);
    const request=(...args)=>{requests++;return send(...args);};
    const listing=async()=>(await fs.readdir(root,{recursive:true})).sort();
    async function seedBars({start,count}) {
      const times=[],bars=[],hashes=[],provenance=JSON.stringify({profile:'closed-ohlcv-atr14-v1',source:'synthetic fixture'});
      for(let i=0;i<count;i++){
        const time=start+i*MINUTE,bar={time,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:'2',price_tick:'0.01',quantity_step:'0.001'};
        times.push(time);bars.push(JSON.stringify(bar));hashes.push(hash(canonical(bar)));
      }
      await db.query("INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',x.t,x.b::jsonb,$1::jsonb,x.h FROM unnest($2::bigint[],$3::text[],$4::text[]) AS x(t,b,h)",[provenance,times,bars,hashes]);
    }
    /**
     * New main account (default role USER, never ADMIN) with a funded Paper policy, one Pine source, one READY deployment
     * with execution evidence and one DRAFT deployment on the same source. A request through `login` is an ordinary
     * password login; the account has no MFA because only privileged roles need it.
     */
    async function newOwner(label,role='USER') {
      const password=randomUUID()+'-fixture',now=Date.now();
      const user=await store.createUser({email:label+'-'+randomUUID()+'@example.test',passwordHash:await hashPassword(password),role}),id=user.id;
      const policy={...structuredClone(config.defaultRisk),paperTrading:true,requireReduceOnlySell:true,equities:{'binance-global':1000},balances:{'binance-global':1000}};
      await store.setRisk(id,policy);
      const f=fixture(),importId=randomUUID();
      await db.prepare('INSERT INTO pine_sources VALUES(?,?,?,?,?,?,?,?,?)').run(importId,id,id,1,hash(source),'Local isolation test only',source,JSON.stringify(f.analysis),now);
      await db.prepare('INSERT INTO pine_source_revisions VALUES(?,?,?,?,?,?)').run(importId,1,hash(source),source,JSON.stringify(f.analysis),now);
      await db.prepare('INSERT INTO pine_memberships VALUES(?,?,?,?,TRUE)').run(importId,id,id,1);
      const members=await db.prepare('SELECT pine_import_id,source_version,source_hash,analysis FROM pine_source_revisions WHERE pine_import_id=?').all(importId);
      const capital=await store.paperAccounts(id),snapshot={source_hash:hash(source),artifact_hash:hash('fixture'),market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},policy,policy_hash:hash(canonical(policy)),capital,funding_cutoff:0,membership:members,selection:validateSelection(f.analysis,f.selection.signals,f.slots,f.selection.bridge)};
      snapshot.funding_cutoff=(await db.prepare('SELECT COALESCE(max(id),0) cutoff FROM paper_funding WHERE user_id=?').get(id)).cutoff;
      const insert=async state=>{
        const deploymentId=randomUUID();
        await db.prepare('INSERT INTO pine_deployments VALUES(?,?,?,?,?,?,?,?,?)').run(deploymentId,id,id,importId,1,JSON.stringify(snapshot),hash(canonical(snapshot)),state,now);
        return deploymentId;
      };
      const deploymentId=await insert('READY'),draftId=await insert('DRAFT');
      const evidence={snapshot_hash:hash(canonical(snapshot)),artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:EXECUTION_MODEL,references:{tradingview:'synthetic-fixture-only',source_review:'synthetic-fixture-only',paper_fixture:'synthetic-fixture-only'}};
      await db.prepare('INSERT INTO pine_bridge_evidence VALUES(?,?,?,?,?)').run(deploymentId,evidence.snapshot_hash,JSON.stringify(evidence),hash(canonical(evidence)),now);
      const owner={user,id,email:user.email,password,importId,deploymentId,draftId,slots:f.slots,bridgeDomains:f.bridge_domains,policy};
      owner.login=async()=>{const answer=await request('/api/auth/login','POST',{email:user.email,password});if(answer.status!==200)throw new Error('fixture login failed '+answer.status);return answer.session;};
      return owner;
    }
    const researchBody=(owner,{start,count=3250,warmup=1250})=>({bot_id:owner.id,deployment_id:owner.deploymentId,parameter_slots:owner.slots,bridge_domains:owner.bridgeDomains,dataset:{start_time:start,end_time:start+(count-1)*MINUTE,warmup_bars:warmup},budget:25,seed:27});
    return {db,store,base,root,request,close,listing,seedBars,newOwner,researchBody,requestCount:()=>requests,minute:MINUTE};
  }catch(error){await close();throw error;}
}
