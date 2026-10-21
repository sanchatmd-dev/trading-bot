import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {canonical,hash,fail} from '../../src/pine-bridge/source.js';
import {QuantDataService,ingestionEngineHash} from '../../src/postgres/quant-data.js';
import {QuantProfileService} from '../../src/postgres/quant-profile.js';
import {QuantPreflightService,trustedSources} from '../../src/postgres/quant-preflight.js';
import {QuantResearchFoundationWorker} from '../../src/postgres/quant-research-foundation.js';
import {validateFoundationRequest} from '../../src/quant-research/foundation-contract.js';
import {expectedFoundationRequestV2} from '../../src/quant-research/research-contract-v2.js';
import {fixedEvalFixture,fixedEvalPostgresFixture} from '../helpers/quant-fixed-eval-fixture.mjs';

test('real PG mixed worker: BACKFILL owner-write serialization retries the whole claim without cancellation',async t=>{
 assert.ok(process.env.TEST_DATABASE_URL,'Root-assigned isolated PostgreSQL required');
 const f=await fixedEvalPostgresFixture(process.env.TEST_DATABASE_URL);t.after(()=>f.close());
 const data=new QuantDataService({pineService:f.service.pine,datasetStore:{},enabled:false});
 const service={db:f.db,foundation:true},worker=new QuantResearchFoundationWorker({service,dataService:data,fixedEvalService:f.service,health:async()=>({ok:true})});
 assert.equal(worker.scheduler.serializable,true);
 const now=Date.now(),end=Math.floor(now/60000)*60000,range={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1',start_time:end-10*60000,end_time:end,warmup_bars:0,cutoff:end};
 const contract=validateFoundationRequest({version:'quant-foundation-v1',owner_id:f.owner,bot_id:f.owner,kind:'BACKFILL',range,
  engine_hash:await ingestionEngineHash(),snapshot_hash:hash(canonical(range)),budget:{candidates:1,max_evaluations:1,chunk_bars:10,max_runtime_ms:900000,max_output_bytes:1048576,max_state_bytes:1048576}});
 const id=randomUUID();await f.db.query("INSERT INTO public.quant_foundation_jobs(job_id,owner_id,idempotency_key,contract,contract_hash,status,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,'QUEUED',$6,$7)",[id,f.owner,'mixed-backfill:'+id,JSON.stringify(contract),hash(canonical(contract)),now,now+900000]);
 let entered,release,scopes=0;const ready=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const scope=data.scope.bind(data);data.scope=async(...args)=>{scopes++;if(scopes===1){entered();await gate;}return scope(...args);};
 const claim=worker.scheduler.claim('fixed-enabled-mixed-worker');
 await ready;
 try{
  // This connection is deliberately outside the claim transaction's AsyncLocalStorage client.
  await f.db.pool.query("UPDATE public.users SET label=COALESCE(label,'')||' mixed-retry' WHERE id=$1",[f.owner]);
 }finally{release();}
 const result=await claim;assert.equal(result.job_id,id);assert.equal(result.status,'RUNNING');assert.equal(scopes,2);
 const row=(await f.db.query('SELECT status,attempts,diagnostic FROM public.quant_foundation_jobs WHERE job_id=$1',[id])).rows[0];
 assert.deepEqual(row,{status:'RUNNING',attempts:1,diagnostic:null});
 assert.equal((await f.db.query('SELECT service_counter FROM public.quant_foundation_scheduler WHERE singleton')).rows[0].service_counter,1);
});

test('shared authority adapters preserve original SQLSTATE and retain application-denial behavior',async()=>{
 const f=fixedEvalFixture(),researchRequest=expectedFoundationRequestV2(f.c,900000),job=randomUUID(),token=randomUUID();
 const adapters=error=>[
  ()=>QuantDataService.prototype.authorize.call({scope:async()=>{throw error;}},'owner',{kind:'BACKFILL',owner_id:'owner',bot_id:'owner'},'CLAIM'),
  ()=>QuantProfileService.prototype.authorizeBindings.call({scope:async()=>{throw error;}},'owner',{bot_id:'owner'}),
  ()=>QuantProfileService.prototype.authorizeV2.call({db:{isTransaction:true,query:async()=>{throw error;}}},'owner',{version:'quant-foundation-v2',kind:'PROFILE',owner_id:'owner'},'ACKNOWLEDGE_STOPPED',{job_id:job,lease_token:token}),
  ()=>QuantPreflightService.prototype.authorize.call({enabled:true,capacityPolicy:{},db:{isTransaction:true},scope:async()=>{throw error;}},'owner',{kind:'PREFLIGHT',owner_id:'owner',bot_id:'owner'},'CLAIM',{job_id:job}),
  ()=>QuantResearchFoundationWorker.prototype.authorize.call({db:{isTransaction:true,query:async sql=>({rows:sql.includes('SELECT q.*')?[f.parent]:[]})},current:async()=>{throw error;}},f.owner,researchRequest,'CLAIM',{})
 ];
 for(const code of ['40001','40P01','42501','08006']){
  const error=Object.assign(Error('synthetic database failure'),{code});
  for(const invoke of adapters(error))await assert.rejects(invoke,errorFound=>errorFound===error);
 }
 for(const invoke of adapters(fail('NOT_FOUND',404)))assert.deepEqual(await invoke(),{ok:false});
});

test('trusted PREFLIGHT source adapter preserves database failures before outward sanitization',async()=>{
 for(const code of ['40001','40P01','42501','08006']){
  const error=Object.assign(Error('synthetic database failure'),{code}),read=async()=>{throw error;};
  const raw={inspect:async()=>{},read:async function*(){}},research={raw:{inspect:async()=>{}},inspectSidecarV2:async()=>{},readV2:async function*(){}};
  const sources=trustedSources({db:{query:read},pine:{authorize:async()=>{}},job_id:randomUUID(),owner_id:'owner',bot_id:'owner',stores:{raw,research}});
  await assert.rejects(()=>sources.authorize({owner_id:'owner',bot_id:'owner'}),found=>found===error);
 }
});

test('trusted PREFLIGHT source adapter keeps unsupported schema errors sanitized',async()=>{
 const raw={inspect:async()=>{},read:async function*(){}},research={raw:{inspect:async()=>{}},inspectSidecarV2:async()=>{},readV2:async function*(){}};
 const sources=trustedSources({db:{query:async()=>({rows:[]})},pine:{authorize:async()=>{}},job_id:randomUUID(),owner_id:'owner',bot_id:'owner',stores:{raw,research}});
 await assert.rejects(()=>sources.authorize({owner_id:'owner',bot_id:'owner'}),{code:'PREFLIGHT_ADAPTER_UNAVAILABLE'});
});
