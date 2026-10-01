import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PostgresDatabase} from '../../src/postgres/db.js';
import {QuantFoundationScheduler} from '../../src/postgres/quant-foundation-scheduler.js';
import {QuantIoLedger} from '../../src/postgres/quant-io-ledger.js';
import {QuantProfileRuntimeV2} from '../../src/postgres/quant-profile-runtime-v2.js';
import {canReleaseQuantIo,quantIoUnitName} from '../../src/postgres/quant-io-runtime.js';
import {createProfileEnrollmentTicketAuthority} from '../../src/postgres/quant-profile-enrollment-ticket.js';
import {loadQuantProfileEnrollmentSchemaAssertion} from '../../src/postgres/quant-profile-enrollment-migration.js';
import {ingestionEngineHash} from '../../src/postgres/quant-data.js';
import {buildProfileV2} from '../../src/quant-research/profile-pipeline-v2.js';
import {ResearchDatasetStore} from '../../src/quant-research/research-dataset-store.js';
import {StorageBudget} from '../../src/quant-research/storage-budget.js';
import {capacityPolicyHash} from '../../src/quant-research/capacity-contract.js';
import {canonical,hash} from '../../src/pine-bridge/source.js';
import {profileV2Fixture} from './profile-v2-fixture.js';

// Synthetic supervision and authority isolate the E2b terminal protocol. The ticket verifier,
// schema verifier, result pipeline, ledger and receipt validator are real. E2a tests SQL authority separately.
export async function createEnrollmentRuntimeFixture(admin){
 const name='enrollment_runtime_'+randomUUID().replaceAll('-','');await admin.query('CREATE DATABASE '+name);
 const url=new URL(process.env.TEST_DATABASE_URL);url.pathname='/'+name;
 const db=new PostgresDatabase({connectionString:url.toString(),max:4});
 let root;
 try{
 for(const file of ['quant-foundation-schema.sql','quant-io-ledger-schema.sql','quant-io-runtime-schema.sql',
  'quant-profile-enrollment-schema.sql'])await db.query(await fs.readFile(new URL('../../src/postgres/'+file,import.meta.url),'utf8'));
 root=await fs.mkdtemp(path.join(os.tmpdir(),'enrollment-runtime-'));
 const budget=new StorageBudget({root,diskQuotaBytes:128*1024*1024,tempQuotaBytes:64*1024*1024,freeFloorBytes:0});
 const store=new ResearchDatasetStore({root,storageBudget:budget,allowUnsupportedDirectorySyncForTests:true});
 const {policy,contract}=profileV2Fixture(600);
 policy.environment='staging';policy.max_raw_bars=10000;
 policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:0,tail_margin_ms:5000};
 contract.capacity.environment='staging';contract.capacity.policy_hash=capacityPolicyHash(policy);
 contract.completion_mode='pf2-enrollment-v1';contract.engine_hash=await ingestionEngineHash();
 async function* rows(){for(let i=0;i<600;i++)yield {time:contract.dataset.metadata.start_time+i*60000,
  open:'100',high:'102',low:'99',close:'101',volume:'2'};}
 contract.dataset=await store.raw.publish(contract.dataset.metadata,rows(),{chunkBars:1000});
 const result=await buildProfileV2({contract,policy,rawStore:store.raw,researchStore:store,now:contract.dataset.metadata.cutoff});
 let now=Date.now(),stops=0,hashReads=0,claimed;
 const knobs={healthy:true,revoked:false,hashMismatch:false,authorityGate:null,terminalGate:null,
  advanceTerminal:0,dropSuccessCommit:false};
 const scheduler=new QuantFoundationScheduler({db,capacityPolicy:policy,profileV2Enabled:true,clock:()=>now,leaseMs:30000,
  authorize:async()=>({ok:true}),health:async()=>({ok:true}),canRelease:job=>canReleaseQuantIo(db,job)});
 const queued=await scheduler.enqueue(contract.owner_id,contract,randomUUID());claimed=await scheduler.claim('enrollment-runtime-test');
 const ledger=new QuantIoLedger({db,policy,devices:[{device_id:'8:0',device_inode:17}],clock:()=>now,
  authorizeTerminal:async()=>({ok:true})});
 const operationId='operation-'+randomUUID(),epoch={};
 const tickets=createProfileEnrollmentTicketAuthority({isTransaction:()=>db.isTransaction,releaseGuard:()=>epoch,
  readExecutableHash:async()=>{hashReads++;if(db.isTransaction)throw Error('filesystem under lock');
   return knobs.hashMismatch?'0'.repeat(64):await ingestionEngineHash();}});
 const assertSchemaLocked=await loadQuantProfileEnrollmentSchemaAssertion();
 const authorityCalls=[];
 const enrollment={enabled:true,tickets,assertSchemaLocked,authorizeLocked:async(owner,value,context)=>{
  authorityCalls.push(context.phase);
  if(!db.isTransaction)throw Error('authority outside lock');
  tickets.assert(context.executionTicket,{...context,contractHash:hash(canonical(value)),
   policyHash:capacityPolicyHash(policy),engineHash:value.engine_hash});
  if(context.phase==='FINALIZE'&&knobs.authorityGate)await knobs.authorityGate;
  return {ok:!knobs.revoked&&owner===contract.owner_id};
 }};
 const launcher={terminalConfig:policy.terminal,spawnPrepared(){throw Error('prepare required');},async prepare({unitName,payload}){
  const expected=quantIoUnitName(claimed.job_id,operationId);if(unitName!==expected)throw Error('unit');
  return {spawnPrepared(){
   const proof={unitName,group:'/user.slice/'+unitName,cgroupInode:23,invocationId:'1'.repeat(32)};
   let delivered,stopped=null;
   const stop=async()=>{if(!stopped){stops++;stopped={unitName,launcherClosed:true,startRegistered:true,
    pendingStartsExcluded:true,unitStopped:true};}return stopped;};
   const sample=()=>({...proof,deviceId:'8:0',deviceInode:17,pid:4242,procStartTicks:'12345',readBytes:4096,writeBytes:4096});
   return {payloadHash:hash(payload),ready:Promise.resolve(proof),accepted:Promise.resolve({unitName,payloadHash:hash(payload)}),
    profileResult:new Promise(resolve=>{delivered=resolve;}),sample:async()=>sample(),stop,
    release(){delivered({jobId:claimed.job_id,operationId,payloadHash:hash(payload),resultHash:hash(canonical(result)),result});},
    async terminate({commit}){
     const frozen=sample(),evidence={freezer:'frozen',windowMs:2500,reads:[{readBytes:4096,writeBytes:4096},
      {readBytes:4096,writeBytes:4096}],fileDirty:0,fileWriteback:0,maxBioBytes:1310720,
      rates:{readBytesPerSecond:524288,writeBytesPerSecond:524288}};
     await commit(frozen,evidence);if(knobs.terminalGate)await knobs.terminalGate;
     now+=knobs.advanceTerminal;
     return {stopProof:await stop(),measured:true,frozenSample:frozen,readbackEvidence:evidence,postExit:'REMOVED'};
    }};
  },async abort(){}};
 }};
 const runtime=new QuantProfileRuntimeV2({db,ledger,scheduler,launcher,storageBudget:budget,clock:()=>now,
  authorizeRelease:async()=>({ok:true}),health:async()=>({ok:knobs.healthy}),enrollment});
 const transaction=db.transaction.bind(db);
 db.transaction=async(...args)=>{const answer=await transaction(...args);
  if(knobs.dropSuccessCommit&&answer?.kind==='ENROLLED'){knobs.dropSuccessCommit=false;throw Error('commit response lost');}
  return answer;};
 const args={jobId:claimed.job_id,leaseToken:claimed.lease_token,operationId,ownerId:claimed.owner_id};
 return {db,knobs,runtime,scheduler,ledger,claimed,args,authorityCalls,advanceClock(ms){now+=ms;},stats:()=>({stops,hashReads}),
  job:async()=>(await db.query('SELECT * FROM quant_foundation_jobs WHERE job_id=$1',[claimed.job_id])).rows[0],
  evidence:async()=>(await db.query(`SELECT to_jsonb(j) job,to_jsonb(r) receipt,to_jsonb(l) ledger,to_jsonb(x) launch
   FROM quant_foundation_jobs j LEFT JOIN quant_profile_enrollment_receipts r USING(job_id)
   LEFT JOIN quant_io_ledgers l USING(job_id) LEFT JOIN quant_io_launches x USING(job_id) WHERE j.job_id=$1`,[claimed.job_id])).rows[0],
  async dispose(){await db.close();await admin.query('DROP DATABASE '+name);await fs.rm(root,{recursive:true,force:true});}};
 }catch(error){
  // Setup can fail before the caller registers t.after(); release this exact fixture here.
  await db.close().catch(()=>{});
  await admin.query('DROP DATABASE IF EXISTS '+name).catch(()=>{});
  if(root)await fs.rm(root,{recursive:true,force:true}).catch(()=>{});
  throw error;
 }
}
