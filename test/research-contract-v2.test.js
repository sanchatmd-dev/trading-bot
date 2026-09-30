import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {canonical,hash} from '../src/pine-bridge/source.js';
import {D} from '../src/money.js';
import {QuantResearchService} from '../src/postgres/quant-research.js';
import {ResearchDatasetStore} from '../src/quant-research/research-dataset-store.js';
import {lockInputs,candidatePlan,RULES} from '../src/quant-research/contract.js';
import {fixture,source} from './helpers/quant-research-fixture.mjs';
import * as contractV2 from '../src/quant-research/research-contract-v2.js';
import {contentDigest,CONTENT_DIGEST_SQL,RESEARCH_V2_VERSIONS,DATASET_BINDING_STEP_ID,DATASET_BINDING_KIND,buildResearchContractV2,validateResearchContractV2,pendingMetadata,expectedFoundationRequestV2,validateFoundationResearchRequestV2,datasetBindingParameters,validateDatasetBindingV1,materializeExecutionContract,datasetBindingIdentity} from '../src/quant-research/research-contract-v2.js';

const moduleFile=fileURLToPath(new URL('../src/quant-research/research-contract-v2.js',import.meta.url));
const START=1800000000000,COUNT=3250,WARMUP=1250,MINUTE=60000,ENGINE='e'.repeat(64);
const OWNER='11111111-1111-4111-8111-111111111111',IMPORT_ID='22222222-2222-4222-8222-222222222222',DEPLOYMENT_ID='33333333-3333-4333-8333-333333333333';
const PROFILE='closed-ohlcv-atr14-v1';
// sha256 of the canonical V1 managed contract HEAD enqueue builds on the standard fixture (engine_hash normalized).
const GOLDEN_V1_SHA256='f9be304402841fa931268da6b00ea9a6363bad8173777ddddfc2b84a7b1f58c6';
const clone=value=>JSON.parse(JSON.stringify(value));
const code=name=>error=>error?.code===name&&error.message===name;

// Standard fixture: 3,250 contiguous verified bars stored the way real market rows are (decimal strings).
function environment(){
 const f=fixture(),policy={paperTrading:true,requireReduceOnlySell:true,equities:{'binance-global':1000},balances:{'binance-global':1000}};
 const capital=[{broker:'binance-global',configuredEquity:'1000',configuredBalance:'900'}];
 const membership=[{pine_import_id:IMPORT_ID,source_version:1,source_hash:hash(source),analysis:f.analysis}];
 const snapshot={source_hash:hash(source),artifact_hash:hash('fixture'),market:{broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'},policy,policy_hash:hash(canonical(policy)),capital,funding_cutoff:0,membership,selection:{...f.selection,bindings:[],fixed_inputs:f.analysis.inputs}};
 const deployment={deployment_id:DEPLOYMENT_ID,owner_id:OWNER,bot_id:OWNER,pine_import_id:IMPORT_ID,source_version:1,state:'READY',snapshot,snapshot_hash:hash(canonical(snapshot))};
 const evidence={snapshot_hash:deployment.snapshot_hash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:{version:'paper-close-v1',price_tick:.01,quantity_step:.001,fee_bps:10,slippage_bps:1,risk_percent:1,data_profile:PROFILE},references:{tradingview:'synthetic-fixture-only',source_review:'synthetic-fixture-only',paper_fixture:'synthetic-fixture-only'}};
 const bars=Array.from({length:COUNT},(_,i)=>({time:START+i*MINUTE,open:'100',high:'101',low:'99',close:'100',volume:'1',atr14:'2',price_tick:'0.01',quantity_step:'0.001'}));
 const rows=bars.map(bar=>({broker:'binance-global',symbol:'BTCUSDT',timeframe:'1',bar_time:bar.time,bar,provenance:{profile:PROFILE,source:'synthetic fixture'},content_hash:hash(canonical(bar))}));
 const body={bot_id:OWNER,deployment_id:DEPLOYMENT_ID,parameter_slots:f.slots,bridge_domains:f.bridge_domains,dataset:{start_time:START,end_time:START+(COUNT-1)*MINUTE,warmup_bars:WARMUP},budget:25,seed:27};
 const sourceRow={pine_import_id:IMPORT_ID,source_version:1,source,source_hash:hash(source),analysis:f.analysis};
 return {f,policy,capital,snapshot,deployment,evidence,bars,rows,body,sourceRow,model:evidence.execution_model,now:START+COUNT*MINUTE+1000};
}
// The values an enqueue holds when it builds a contract, computed by the same repository functions HEAD uses.
function buildInput(env,overrides={}){
 const lock=lockInputs(env.sourceRow.analysis,env.snapshot.selection,env.body.parameter_slots,env.body.bridge_domains);
 const plan=candidatePlan(lock,env.body.budget,env.body.seed);
 const capital=env.snapshot.capital.find(c=>c.broker===env.snapshot.market.broker);
 return {owner_id:OWNER,bot_id:OWNER,deployment:env.deployment,source:env.sourceRow,snapshot:env.snapshot,lock,plan,model:env.model,rules:RULES,capital,engine_hash:ENGINE,dataset:{...env.body.dataset,content_digest:contentDigest(env.rows)},...overrides};
}
const buildV2=(env,overrides)=>buildResearchContractV2(buildInput(env,overrides));

// U2: the digest is defined by text, so the vector is written out and hashed independently of the module.
const ROWS3=[{bar_time:1800000000000,content_hash:'a'.repeat(64)},{bar_time:1800000060000,content_hash:'b'.repeat(64)},{bar_time:1800000120000,content_hash:'c'.repeat(64)}];
const TEXT3=['1800000000000:'+'a'.repeat(64),'1800000060000:'+'b'.repeat(64),'1800000120000:'+'c'.repeat(64)].join(String.fromCharCode(10));
const VECTOR3=createHash('sha256').update(TEXT3,'utf8').digest('hex');
test('U2 digest vector: fixed rows give a fixed hex and the documented text',()=>{
 assert.equal(VECTOR3,'16a11b7764dbf18f33ed7b1eecc5160dc981ff6b8add565370477d1be6e078cd');
 assert.equal(contentDigest(ROWS3),VECTOR3);
 assert.equal(contentDigest(ROWS3.map(row=>({...row,extra:'ignored',bar:{time:1}}))),VECTOR3);
 assert.equal(contentDigest([ROWS3[0]]),createHash('sha256').update('1800000000000:'+'a'.repeat(64)).digest('hex'),'one row has no line feed');
 assert.notEqual(contentDigest([ROWS3[0],ROWS3[1]]),VECTOR3);
 assert.notEqual(contentDigest([{...ROWS3[0],content_hash:'d'.repeat(64)},ROWS3[1],ROWS3[2]]),VECTOR3);
 assert.notEqual(contentDigest([{...ROWS3[0],bar_time:1800000000001},ROWS3[1],ROWS3[2]]),VECTOR3);
});
test('U2 digest rejects empty, unordered, duplicate, malformed and oversize input with one fixed code',()=>{
 const unverified=code('VERIFIED_MARKET_DATA_REQUIRED');
 const reject=rows=>assert.throws(()=>contentDigest(rows),unverified);
 reject([]);reject(undefined);reject(null);reject('rows');reject({length:1,0:ROWS3[0]});
 reject([ROWS3[1],ROWS3[0]]);reject([ROWS3[0],ROWS3[0]]);reject([ROWS3[0],undefined]);reject([null]);
 reject([{...ROWS3[0],bar_time:'1800000000000'}]);reject([{...ROWS3[0],bar_time:1.5}]);reject([{...ROWS3[0],bar_time:0}]);reject([{...ROWS3[0],bar_time:-60000}]);
 reject([{...ROWS3[0],bar_time:2**53}]);reject([{...ROWS3[0],bar_time:10n}]);reject([{...ROWS3[0],bar_time:null}]);
 reject([{...ROWS3[0],content_hash:'A'.repeat(64)}]);reject([{...ROWS3[0],content_hash:'a'.repeat(63)}]);reject([{...ROWS3[0],content_hash:'a'.repeat(65)}]);reject([{...ROWS3[0],content_hash:'g'.repeat(64)}]);
 reject([{...ROWS3[0],content_hash:'a'.repeat(63)+'\n'}]);reject([{bar_time:1800000000000}]);reject([{...ROWS3[0],content_hash:Buffer.alloc(32)}]);
 const big=Array.from({length:10001},(_,i)=>({bar_time:(i+1)*MINUTE,content_hash:'a'.repeat(64)}));
 reject(big);
 assert.equal(contentDigest(big.slice(0,10000)).length,64,'10,000 rows are the accepted maximum');
});
test('U2 digest SQL shape: ordered aggregate, cast-free NULL-safe row filters, three parameters, no row payload',()=>{
 const sql=CONTENT_DIGEST_SQL;
 for(const part of ["string_agg(bar_time::text||':'||content_hash,chr(10) ORDER BY bar_time)",'sha256(convert_to(',"'UTF8'",",'hex')","provenance->>'profile' IS DISTINCT FROM $3::text","bar->'time' IS DISTINCT FROM to_jsonb(bar_time)","content_hash !~ '^[a-f0-9]{64}$'",'bar_time>=$1 AND bar_time<=$2',"broker='binance-global' AND symbol='BTCUSDT' AND timeframe='1'"])assert.ok(sql.includes(part),part);
 assert.deepEqual([...new Set(sql.match(/\$\d+/g))].sort(),['$1','$2','$3']);
 assert.equal(/->>'time'|::bigint|::int8|::numeric|SELECT \*/.test(sql),false,'no cast of untrusted text and no full row load');
 assert.equal(sql.includes(String.fromCharCode(92)),false,'no string-escape dependent separator');
});
test('versions, step id and kind carry the accepted names',()=>{
 assert.deepEqual(RESEARCH_V2_VERSIONS,{contract:'ql3a-research-job-v2',execution:'ql3a-research-job-v1',request:'quant-foundation-research-v2',binding:'quant-research-dataset-binding-v1',digest:'pine-bar-content-digest-v1'});
 assert.equal(Object.isFrozen(RESEARCH_V2_VERSIONS),true);
 assert.equal(DATASET_BINDING_STEP_ID,'prepare:dataset');assert.equal(DATASET_BINDING_KIND,'PREPARE');
 assert.deepEqual(Object.keys(contractV2).sort(),['CONTENT_DIGEST_SQL','DATASET_BINDING_KIND','DATASET_BINDING_STEP_ID','RESEARCH_V2_VERSIONS','buildResearchContractV2','contentDigest','datasetBindingIdentity','datasetBindingParameters','expectedFoundationRequestV2','materializeExecutionContract','pendingMetadata','validateDatasetBindingV1','validateFoundationResearchRequestV2','validateResearchContractV2'],'export surface is exactly the design list');
});

// U1 runs HEAD's own managed FOUNDATION enqueue against in-memory answers, so the expected V1 contract is built
// by the repository, not by this module. Only the SQL the enqueue issues is answered; any other statement fails.
// The managed V1 enqueue is retired when the V2 enqueue lands. That change deletes the live U1 test and headEnqueue;
// the golden test below then keeps the parity with the recorded V1 bytes.
async function headEnqueue(env,datasetStore){
 const stop=new Error('captured'),captured={};
 const answers=[
  ["to_regclass('quant_research_executor_mode')",()=>[{present:'quant_research_executor_mode'}]],
  ['SELECT mode FROM quant_research_executor_mode',()=>[{mode:'FOUNDATION'}]],
  ['FROM quant_foundation_scheduler',()=>[]],
  ['FROM quant_jobs WHERE owner_id=? AND bot_id=? AND idempotency_key=?',()=>[]],
  ['FROM pine_deployments WHERE owner_id=? AND bot_id=? AND deployment_id=?',()=>[env.deployment]],
  ['FROM pine_memberships m',()=>env.snapshot.membership.map(row=>({...row}))],
  ['FROM paper_funding WHERE user_id=?',()=>[{cutoff:0}]],
  ['FROM pine_bridge_evidence WHERE deployment_id=?',()=>[{deployment_id:DEPLOYMENT_ID,snapshot_hash:env.deployment.snapshot_hash,evidence:env.evidence,evidence_hash:hash(canonical(env.evidence))}]],
  ["FROM quant_jobs WHERE status IN ('QUEUED','RUNNING')",()=>[{total:0,own:0}]],
  ['FROM quant_foundation_jobs WHERE status IN',()=>[{total:0,owned:0}]],
  ['SELECT count(*) n,min(bar_time) first_time',()=>[{n:env.rows.length,first_time:env.rows[0].bar_time,last_time:env.rows.at(-1).bar_time}]],
  ['SELECT * FROM pine_market_bars',()=>env.rows],
  ['INSERT INTO quant_jobs(',(sql,params)=>{captured.contract=params[7];return [];}],
  ['INSERT INTO quant_foundation_owners',()=>[]],
  ['INSERT INTO quant_foundation_jobs',(sql,params)=>{captured.request=params[3];return [];}],
  ['INSERT INTO quant_research_foundation',()=>[]],
 ];
 const answer=async(sql,params=[])=>{
  const match=answers.find(([part])=>sql.includes(part));
  if(!match)throw new Error('unexpected SQL: '+sql.slice(0,90));
  return match[1](sql,params);
 };
 const db={isTransaction:true,lock:async()=>{},query:async(sql,params)=>({rows:await answer(sql,params)}),prepare:sql=>({get:async(...params)=>(await answer(sql,params))[0],all:(...params)=>answer(sql,params),run:async(...params)=>{await answer(sql,params);return {changes:1};}})};
 const store={audit:async()=>{throw stop;},getBotSession:async()=>({locked_policy:JSON.stringify(env.policy)}),paperAccounts:async()=>env.capital.map(row=>({...row})),risk:async()=>env.policy};
 const pine={db,store,defaultRisk:env.policy,authorize:async()=>{},source:async()=>env.sourceRow};
 const service=new QuantResearchService({pineService:pine,clock:()=>env.now,supportedSourceHash:hash(source),foundation:true,datasetStore});
 await assert.rejects(service.enqueue(OWNER,env.body,'idempotency-key-1'),error=>error===stop);
 return {contract:JSON.parse(captured.contract),request:JSON.parse(captured.request)};
}
// What the PREPARE step will do with a V2 contract: publish the pending dataset, hash the rows with the V1 formula, bind.
async function prepareLikeWorker(env,contract,root){
 const store=new ResearchDatasetStore({root});
 const references=await store.publish(pendingMetadata(contract),env.rows.map(row=>row.bar),{model:contract.model});
 const datasetSha256=hash(canonical(env.rows.map(row=>({bar:row.bar,content_hash:row.content_hash,provenance:row.provenance}))));
 const binding=datasetBindingParameters(contract,{references,dataset_sha256:datasetSha256});
 return {references,datasetSha256,binding,execution:materializeExecutionContract(contract,binding)};
}
const scratch=async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'research-contract-v2-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;};

test('U1 parity: materialized V2 contract equals the V1 managed contract HEAD enqueue builds',async t=>{
 const env=environment(),head=await headEnqueue(env,new ResearchDatasetStore({root:await scratch(t)}));
 assert.equal(head.contract.version,'ql3a-research-job-v1');assert.equal(head.contract.execution_backend,'quant-foundation-v1');
 assert.notEqual(head.contract.engine_hash,ENGINE,'HEAD hashes the real engine files; normalize before comparing');
 const v1={...head.contract,engine_hash:ENGINE},v2=buildV2(env);
 const prepared=await prepareLikeWorker(env,v2,await scratch(t));
 assert.deepEqual(prepared.references,head.contract.dataset.references,'PREPARE publish yields the references HEAD enqueue published');
 assert.equal(prepared.datasetSha256,head.contract.dataset.sha256,'file digest follows the V1 formula');
 assert.equal(canonical(prepared.execution),canonical(v1));assert.equal(hash(canonical(v1)),GOLDEN_V1_SHA256,'golden value stays tied to the HEAD capture');
 assert.deepEqual(Object.keys(prepared.execution).sort(),Object.keys(v1).sort());
 assert.notEqual(v2.version,v1.version);assert.equal(hash(canonical(v2))!==hash(canonical(v1)),true,'stored V2 identity differs from the V1 identity');
 const request=expectedFoundationRequestV2(v2,900000);
 const {version:requestVersion,pending_dataset:pending,...requestRest}=request,{version:headVersion,dataset:headDataset,...headRest}=head.request;
 assert.equal(requestVersion,RESEARCH_V2_VERSIONS.request);assert.equal(headVersion,'quant-foundation-v1');
 assert.deepEqual(requestRest,{...headRest,engine_hash:ENGINE},'owner, bot, kind, hashes and budget match the V1 request');
 assert.deepEqual(pending.metadata,headDataset.metadata,'pending metadata equals the V1 dataset metadata');
 assert.equal(validateFoundationResearchRequestV2(request,v2).version,RESEARCH_V2_VERSIONS.request);
});
test('U1 golden: prepared V2 execution contract keeps the V1 managed bytes (survives the V1 enqueue retirement)',async t=>{
 const env=environment(),v2=buildV2(env),prepared=await prepareLikeWorker(env,v2,await scratch(t));
 assert.equal(hash(canonical(prepared.execution)),GOLDEN_V1_SHA256);
});

// U3 fixtures. Contract and binding tampers are applied to copies; a copy that stays valid is a test defect.
const edit=(value,change)=>{const copy=structuredClone(value);change(copy);return copy;};
const invalidContract=code('INVALID_RESEARCH_CONTRACT_V2'),invalidBinding=code('RESEARCH_DATASET_BINDING_INVALID');
const base=(()=>{const env=environment(),v2=buildV2(env);return {env,v2};})();
const syntheticReferences=v2=>({raw:{dataset_id:'d'.repeat(64),sha256:'d'.repeat(64),metadata:pendingMetadata(v2)},sidecar:{sha256:'5'.repeat(64),bar_count:v2.dataset.bar_count,first_time:v2.dataset.start_time,profile:PROFILE,price_tick:'0.01',quantity_step:'0.001'}});
const bind=(v2=base.v2)=>datasetBindingParameters(v2,{references:syntheticReferences(v2),dataset_sha256:'9'.repeat(64)});
const withGetter=(value,name)=>{const copy=structuredClone(value),current=copy[name];Object.defineProperty(copy,name,{get:()=>current,enumerable:true});return copy;};
const withSymbol=value=>{const copy=structuredClone(value);copy[Symbol('extra')]=1;return copy;};
const splitTo=x=>{const w=x.dataset.warmup_bars,n=x.dataset.bar_count,c=n-w;return {warmup:w,train_end:w+Math.floor(c*.6),validation_end:w+Math.floor(c*.8),test_end:n};};

test('U3 contract: builder output is the exact V1 managed key set with a range-and-digest dataset',()=>{
 const {v2,env}=base;
 assert.deepEqual(Object.keys(v2).sort(),['acceptance_blockers','baseline_snapshot_hash','bot_id','capital','dataset','deployment_id','engine_hash','execution_backend','input_lock','ledger_initialization','max_evaluations','model','owner_id','pine_import_id','plan','rules','scope','snapshot','source','source_hash','source_version','split','version'].sort());
 assert.deepEqual(v2.dataset,{start_time:START,end_time:START+(COUNT-1)*MINUTE,warmup_bars:WARMUP,bar_count:COUNT,first_time:START,timestamp_semantics:'verified closed-bar timestamps; half-open index end is last timestamp plus one minute',content_digest:contentDigest(env.rows),digest_version:'pine-bar-content-digest-v1'});
 assert.deepEqual(v2.split,{warmup:1250,train_end:2450,validation_end:2850,test_end:3250});
 assert.equal(v2.version,'ql3a-research-job-v2');assert.equal(v2.execution_backend,'quant-foundation-v1');assert.equal(v2.engine_hash,ENGINE);
 assert.equal(canonical(validateResearchContractV2(v2)),canonical(v2));
 const frozen=structuredClone(v2);Object.freeze(frozen);
 const copy=validateResearchContractV2(frozen);assert.notEqual(copy,frozen);assert.notEqual(copy.dataset,frozen.dataset);assert.equal(canonical(frozen),canonical(v2),'input is not mutated');
});
test('U3 contract: exact keys at both levels; bars, sha256 and references are rejected',()=>{
 const {v2}=base;
 for(const key of Object.keys(v2))assert.throws(()=>validateResearchContractV2(edit(v2,x=>{delete x[key];})),invalidContract,'missing '+key);
 for(const key of Object.keys(v2.dataset))assert.throws(()=>validateResearchContractV2(edit(v2,x=>{delete x.dataset[key];})),invalidContract,'missing dataset.'+key);
 assert.throws(()=>validateResearchContractV2(edit(v2,x=>{x.extra=1;})),invalidContract);
 assert.throws(()=>validateResearchContractV2(edit(v2,x=>{x.dataset.extra=1;})),invalidContract);
 assert.throws(()=>validateResearchContractV2(edit(v2,x=>{x.dataset.bars=[];})),invalidContract);
 assert.throws(()=>validateResearchContractV2(edit(v2,x=>{x.dataset.sha256='a'.repeat(64);})),invalidContract);
 assert.throws(()=>validateResearchContractV2(edit(v2,x=>{x.dataset.references=syntheticReferences(v2);})),invalidContract);
 for(const bad of [null,undefined,'contract',7,[],[v2]])assert.throws(()=>validateResearchContractV2(bad),invalidContract);
});
test('U3 contract: version, identity, hash, dataset, split and derived-field tampers are rejected',()=>{
 const {v2}=base,rejects=(change,label)=>assert.throws(()=>validateResearchContractV2(edit(v2,change)),invalidContract,label);
 rejects(x=>{x.version='ql3a-research-job-v1';},'v1 version');rejects(x=>{x.scope='OTHER';},'scope');rejects(x=>{x.execution_backend='quant-foundation-v2';},'backend');
 rejects(x=>{x.owner_id='bad owner';},'owner id');rejects(x=>{x.bot_id='';},'bot id');rejects(x=>{x.deployment_id='';},'deployment');rejects(x=>{x.source_version=0;},'source version');rejects(x=>{x.source_version='1';},'source version type');
 for(const name of ['source_hash','baseline_snapshot_hash','engine_hash']){rejects(x=>{x[name]='A'.repeat(64);},name+' case');rejects(x=>{x[name]='a'.repeat(63);},name+' length');rejects(x=>{x[name]=7;},name+' type');}
 rejects(x=>{x.source+=' ';},'source text no longer matches its hash');
 rejects(x=>{x.snapshot.selection={};},'snapshot selection differs from the lock');rejects(x=>{x.input_lock.lock_hash='z';},'lock hash');rejects(x=>{x.plan.planned_candidates+=1;},'plan count');
 for(const [count,label] of [[101,'plan above 100'],[0,'empty plan']]){rejects(x=>{x.plan.candidates=Array.from({length:count},(_,i)=>({index:i}));x.plan.planned_candidates=count;x.max_evaluations=count+2*Object.keys(x.input_lock.domains).length+5;},label);}
 for(const name of ['snapshot','input_lock','plan','model','rules','capital','split','dataset'])for(const bad of [[],null,'text',7])rejects(x=>{x[name]=bad;},name+' is not an object: '+JSON.stringify(bad));rejects(x=>{x.plan.candidates.pop();},'plan list');
 rejects(x=>{x.model.data_profile='other';},'profile');rejects(x=>{delete x.model.price_tick;},'tick');rejects(x=>{x.model.quantity_step=0;},'step');
 rejects(x=>{delete x.rules.maximum_drawdown_percent;},'rules');rejects(x=>{x.rules.extra=1;},'rules extra');rejects(x=>{x.rules.minimum_closed_trades_train='5';},'rules type');
 rejects(x=>{x.capital.extra=1;},'capital');rejects(x=>{x.capital.cash=null;},'cash');rejects(x=>{x.ledger_initialization='x';},'ledger');rejects(x=>{x.acceptance_blockers.pop();},'blockers');rejects(x=>{x.max_evaluations+=1;},'evaluation cap');
 const d=(change,label)=>rejects(x=>change(x.dataset),'dataset '+label);
 const dr=(change,label)=>rejects(x=>{change(x.dataset);x.split=splitTo(x);},'dataset '+label+' with a consistent split');
 dr(set=>{set.bar_count+=1;},'bar_count plus one');dr(set=>{set.bar_count-=1;},'bar_count minus one');dr(set=>{set.bar_count=3250.5;},'bar_count fraction');dr(set=>{set.bar_count=0;},'bar_count zero');
 d(set=>{set.start_time+=1;set.first_time+=1;},'start off grid');d(set=>{set.end_time+=1;},'end off grid');dr(set=>{set.start_time=set.end_time;set.first_time=set.end_time;set.bar_count=1;set.warmup_bars=0;},'start not before end');
 d(set=>{set.first_time+=MINUTE;},'first_time differs');d(set=>{set.timestamp_semantics='UTC open time; end exclusive';},'timestamp text');
 d(set=>{set.content_digest='F'.repeat(64);},'digest case');d(set=>{set.content_digest=null;},'digest null');d(set=>{set.digest_version='pine-bar-content-digest-v2';},'digest version');
 dr(set=>{set.warmup_bars=set.bar_count;},'warmup as large as the range');dr(set=>{set.warmup_bars=-1;},'warmup negative');dr(set=>{set.end_time=set.start_time+5999*MINUTE;set.bar_count=6000;set.warmup_bars=5001;},'warmup above 5,000');
 assert.equal(validateResearchContractV2(edit(v2,x=>{x.dataset.end_time=x.dataset.start_time+5999*MINUTE;x.dataset.bar_count=6000;x.dataset.warmup_bars=5000;x.split=splitTo(x);})).dataset.warmup_bars,5000,'warmup 5,000 passes');
 rejects(x=>{x.split.train_end+=1;},'split train');rejects(x=>{x.split.test_end-=1;},'split test');rejects(x=>{x.split.extra=1;},'split extra');
 const wide=edit(v2,x=>{x.dataset.end_time=x.dataset.start_time+10000*MINUTE;x.dataset.bar_count=10001;x.split=splitTo(x);});
 assert.throws(()=>validateResearchContractV2(wide),invalidContract,'10,001 bars');
 const limit=edit(v2,x=>{x.dataset.end_time=x.dataset.start_time+9999*MINUTE;x.dataset.bar_count=10000;x.split=splitTo(x);});
 assert.equal(validateResearchContractV2(limit).dataset.bar_count,10000,'10,000 bars pass');
});
// Capital, price tick and quantity step are strictly positive. A string must be the plain decimal V1 stores (Decimal
// toFixed): digits with an optional fraction, no sign, no exponent, no blank, no leading zero, below 1e20, 120 characters.
const POSITIVE_FIELDS=[['capital','equity'],['capital','cash'],['model','price_tick'],['model','quantity_step']];
const NON_POSITIVE_TEXT=['','-5','+5','abc','1e3','1E3','5e-3',' 5','5 ','5'+String.fromCharCode(10),String.fromCharCode(10)+'5','5'+String.fromCharCode(9),'5.','.5','.','5..5','5.5.5','1,5','0x10','Infinity','NaN','007','00.5','-0','0','0.0','0.000','0.000000000000000000','-1','-0.5','-0.000',String.fromCharCode(0xFF15),String.fromCharCode(0x0663),'100000000000000000000','0.'+'1'.repeat(119)];
const NON_POSITIVE_VALUE=[0,-0,-1,-1e-9,Number.NaN,Infinity,-Infinity,1e20,1e21,null,undefined,true,false,[],[1],{},{value:1},10n];
const POSITIVE_TEXT=['1000','900','1','10','0.01','0.001','0.5','1.5','0.10','5.50','123456789.123456789012345678','0.000000000000000001','99999999999999999999','99999999999999999999.999999999999999999','0.'+'1'.repeat(118)];
const POSITIVE_NUMBER=[1,900,1000,0.5,0.01,0.001,1e-7,1e19];
const v1Takes=value=>{try{return D(value).gt(0);}catch{return false;}};
test('U3 contract: capital, price tick and quantity step reject non-positive, malformed and out-of-range values',()=>{
 const {v2}=base,invalid=(path,value)=>assert.throws(()=>validateResearchContractV2(edit(v2,x=>{x[path[0]][path[1]]=value;})),invalidContract,path.join('.')+' '+String(typeof value==='bigint'?value+'n':JSON.stringify(value)));
 for(const path of POSITIVE_FIELDS){
  for(const bad of [...NON_POSITIVE_TEXT,...NON_POSITIVE_VALUE])invalid(path,bad);
  invalid(path,undefined);
 }
});
test('U3 contract: capital, price tick and quantity step accept positive plain decimal strings and numbers V1 accepts',()=>{
 const {v2}=base;
 for(const path of POSITIVE_FIELDS)for(const good of [...POSITIVE_TEXT,...POSITIVE_NUMBER]){
  const changed=edit(v2,x=>{x[path[0]][path[1]]=good;});
  assert.equal(canonical(validateResearchContractV2(changed)),canonical(changed),path.join('.')+' '+good);
  assert.equal(v1Takes(good),true,'V1 D() accepts '+good+' as a positive amount');
 }
 for(const text of ['+5','1e3','5.','.5','007'])assert.equal(v1Takes(text),true,'V1 D() itself takes '+text+'; the contract is stricter on purpose');
 for(const text of ['','-5','abc',' 5','0','0.000'])assert.equal(v1Takes(text),false,'V1 refuses '+JSON.stringify(text));
});
test('U3 builder: capital, price tick and quantity step take the same positive plain decimal rule',()=>{
 const {env}=base,input=buildInput(env);
 const capital=(equity,cash)=>({configuredEquity:equity,configuredBalance:cash});
 for(const bad of ['','-5','abc','1e3',' 5','5.','.5','0',0,-1])for(const which of [0,1]){
  const pair=which===0?[bad,'900']:['1000',bad];
  assert.throws(()=>buildResearchContractV2({...input,capital:capital(...pair)}),invalidContract,'capital '+JSON.stringify(pair));
 }
 for(const field of ['price_tick','quantity_step'])for(const bad of ['abc','0','0.000','-1','',0,-1])assert.throws(()=>buildResearchContractV2({...input,model:{...env.model,[field]:bad}}),invalidContract,field+' '+JSON.stringify(bad));
 const text=buildResearchContractV2({...input,capital:capital('1000.5','0.25'),model:{...env.model,price_tick:'0.010',quantity_step:'0.0010'}});
 assert.deepEqual(text.capital,{equity:'1000.5',cash:'0.25'});
 assert.equal(text.model.price_tick,'0.010');
});
test('U3 contract: getters, symbols, accessors and non-JSON leaves are rejected (strictJsonV2)',()=>{
 const {v2}=base,rejects=change=>assert.throws(()=>validateResearchContractV2(edit(v2,change)),invalidContract);
 assert.throws(()=>validateResearchContractV2(withGetter(v2,'owner_id')),invalidContract);
 rejects(x=>{x.dataset=withGetter(x.dataset,'bar_count');});
 assert.throws(()=>validateResearchContractV2(withSymbol(v2)),invalidContract);
 rejects(x=>{x.dataset[Symbol('extra')]=1;});
 rejects(x=>{x.plan.candidates=new Array(x.plan.candidates.length);});
 rejects(x=>{x.snapshot.note=undefined;});rejects(x=>{x.snapshot.note=Number.NaN;});rejects(x=>{x.snapshot.note=new Date(0);});rejects(x=>{x.snapshot.note=10n;});rejects(x=>{x.snapshot.note=()=>1;});
 rejects(x=>{Object.defineProperty(x.snapshot,'note',{value:1,enumerable:false});});
 rejects(x=>{x.snapshot.self=x.snapshot;});
 class Custom{constructor(){this.a=1;}}
 rejects(x=>{x.snapshot.note=new Custom();});
});
test('U3 builder: bad or hostile inputs are rejected with the contract code',()=>{
 const {env}=base,input=buildInput(env);
 const rejects=overrides=>assert.throws(()=>buildResearchContractV2({...input,...overrides}),invalidContract);
 assert.throws(()=>buildResearchContractV2(),invalidContract);assert.throws(()=>buildResearchContractV2({}),invalidContract);
 rejects({deployment:undefined});rejects({source:{source:'x',source_hash:'y'}});rejects({owner_id:'bad owner'});rejects({rules:{...RULES,extra:1}});rejects({engine_hash:'nope'});
 rejects({dataset:{...input.dataset,end_time:input.dataset.end_time+1}});rejects({dataset:{...input.dataset,start_time:input.dataset.start_time+1}});rejects({dataset:{...input.dataset,content_digest:'nope'}});
 rejects({dataset:{...input.dataset,warmup_bars:4999+1000}});rejects({dataset:{...input.dataset,end_time:input.dataset.start_time+10000*MINUTE}});
 rejects({snapshot:'text'});rejects({model:{...env.model,data_profile:'other'}});
 rejects({capital:{configuredEquity:undefined,configuredBalance:'1'}});rejects({plan:{...input.plan,candidates:[]}});
 rejects({lock:withGetter(input.lock,'lock_hash')});rejects({snapshot:withSymbol(input.snapshot)});rejects({snapshot:withGetter(input.snapshot,'artifact_hash')});
 assert.equal(buildResearchContractV2({...input,dataset:{...input.dataset,end_time:input.dataset.start_time+9999*MINUTE}}).dataset.bar_count,10000);
});
test('U3 pending metadata is the spot-dataset-v1 half-open range of the contract',()=>{
 const {v2}=base;
 assert.deepEqual(pendingMetadata(v2),{version:'spot-dataset-v1',venue:'binance-global',market:'SPOT',symbol:'BTCUSDT',timeframe:'1',start_time:START,end_time:START+COUNT*MINUTE,warmup_bars:WARMUP,total_bars:COUNT,cutoff:START+COUNT*MINUTE,source:'binance-spot-klines-v1'});
 assert.throws(()=>pendingMetadata(edit(v2,x=>{x.dataset.bar_count+=1;})),invalidContract);
});
test('U3 request: builds the exact pending OPTIMIZE request and validates it against the contract',()=>{
 const {v2}=base,request=expectedFoundationRequestV2(v2,900000);
 assert.deepEqual(Object.keys(request).sort(),['bot_id','budget','engine_hash','kind','owner_id','pending_dataset','snapshot_hash','version']);
 assert.equal(request.version,'quant-foundation-research-v2');assert.equal(request.kind,'OPTIMIZE');
 assert.deepEqual(request.pending_dataset,{metadata:pendingMetadata(v2),content_digest:v2.dataset.content_digest,digest_version:'pine-bar-content-digest-v1'});
 assert.deepEqual(request.budget,{candidates:v2.plan.planned_candidates,max_evaluations:v2.max_evaluations,chunk_bars:1000,max_runtime_ms:900000,max_output_bytes:8*1024*1024,max_state_bytes:1024*1024});
 assert.equal(request.snapshot_hash,v2.baseline_snapshot_hash);assert.equal(request.engine_hash,v2.engine_hash);
 assert.equal(Object.hasOwn(request,'dataset'),false,'no dataset reference exists before PREPARE');
 assert.equal(canonical(validateFoundationResearchRequestV2(request)),canonical(request));
 assert.equal(canonical(validateFoundationResearchRequestV2(request,v2)),canonical(request));
 assert.equal(validateFoundationResearchRequestV2(edit(request,x=>{x.budget.max_runtime_ms=60000;}),v2).budget.max_runtime_ms,60000,'the runtime cap is the only value read from the request');
 const small=edit(v2,x=>{x.dataset.end_time=x.dataset.start_time+2199*MINUTE;x.dataset.bar_count=2200;x.split=splitTo(x);});
 assert.equal(expectedFoundationRequestV2(small,900000).budget.chunk_bars,1000);
 const tiny=edit(v2,x=>{x.dataset.warmup_bars=0;x.dataset.end_time=x.dataset.start_time+599*MINUTE;x.dataset.bar_count=600;x.split=splitTo(x);});
 assert.equal(expectedFoundationRequestV2(tiny,900000).budget.chunk_bars,600,'chunk_bars follows the V1 formula min(1000, bar_count)');
});
test('U3 request: exact keys, OPTIMIZE only, version, ids and hashes',()=>{
 const {v2}=base,request=expectedFoundationRequestV2(v2,900000),rejects=(change,name)=>assert.throws(()=>validateFoundationResearchRequestV2(edit(request,change)),code(name),name);
 for(const key of Object.keys(request))rejects(x=>{delete x[key];},'INVALID_FIELDS');
 for(const key of ['dataset','profile','capacity','extra'])rejects(x=>{x[key]={};},'INVALID_FIELDS');
 for(const key of Object.keys(request.pending_dataset))rejects(x=>{delete x.pending_dataset[key];},'INVALID_FIELDS');
 for(const key of Object.keys(request.budget))rejects(x=>{delete x.budget[key];},'INVALID_FIELDS');
 rejects(x=>{x.pending_dataset.extra=1;},'INVALID_FIELDS');rejects(x=>{x.budget.extra=1;},'INVALID_FIELDS');
 rejects(x=>{x.version='quant-foundation-v1';},'UNSUPPORTED_FOUNDATION_VERSION');rejects(x=>{x.version='quant-foundation-v2';},'UNSUPPORTED_FOUNDATION_VERSION');
 for(const kind of ['PREFLIGHT','BACKTEST','REPORT','BACKFILL','PROFILE','optimize',''])rejects(x=>{x.kind=kind;},'INVALID_FOUNDATION_KIND');
 rejects(x=>{x.kind=undefined;},'INVALID_FIELDS');
 rejects(x=>{x.owner_id='bad owner';},'INVALID_FOUNDATION_ID');rejects(x=>{x.bot_id='';},'INVALID_FOUNDATION_ID');
 for(const name of ['engine_hash','snapshot_hash'])rejects(x=>{x[name]='A'.repeat(64);},'INVALID_FOUNDATION_HASH');
 rejects(x=>{x.pending_dataset.content_digest='a'.repeat(63);},'INVALID_FOUNDATION_HASH');rejects(x=>{x.pending_dataset.digest_version='pine-bar-content-digest-v2';},'UNSUPPORTED_FOUNDATION_VERSION');
 rejects(x=>{x.pending_dataset.metadata.symbol='ETHUSDT';},'UNSUPPORTED_DATASET_PROFILE');rejects(x=>{x.pending_dataset.metadata.total_bars+=1;},'INVALID_DATASET_INTERVAL');rejects(x=>{x.pending_dataset.metadata.cutoff+=MINUTE;},'INVALID_DATASET_INTERVAL');
 for(const bad of [null,undefined,'request',7,[],[request]])assert.throws(()=>validateFoundationResearchRequestV2(bad),code('INVALID_FIELDS'));
});
test('U3 request: 10,000-bar ceiling and every budget bound',()=>{
 const {v2}=base,request=expectedFoundationRequestV2(v2,900000),rejects=change=>assert.throws(()=>validateFoundationResearchRequestV2(edit(request,change)),code('INVALID_FOUNDATION_BUDGET'));
 const wide=edit(request,x=>{const m=x.pending_dataset.metadata;m.total_bars=10001;m.end_time=m.start_time+10001*MINUTE;m.cutoff=m.end_time;});
 assert.throws(()=>validateFoundationResearchRequestV2(wide),code('FOUNDATION_CAPABILITY_LIMIT'),'total_bars 10,001');
 const edge=edit(request,x=>{const m=x.pending_dataset.metadata;m.total_bars=10000;m.end_time=m.start_time+10000*MINUTE;m.cutoff=m.end_time;});
 assert.equal(validateFoundationResearchRequestV2(edge).pending_dataset.metadata.total_bars,10000,'10,000 bars are admitted');
 assert.equal(validateFoundationResearchRequestV2(edit(edge,x=>{x.budget.chunk_bars=10000;})).budget.chunk_bars,10000,'chunk_bars may reach the total');
 const bounds={candidates:100,max_evaluations:125,chunk_bars:3250,max_runtime_ms:900000,max_output_bytes:8*1024*1024,max_state_bytes:1024*1024};
 assert.equal(validateFoundationResearchRequestV2(edit(request,x=>{Object.assign(x.budget,bounds);})).budget.chunk_bars,3250,'every maximum is accepted');
 for(const [name,max] of Object.entries(bounds)){
  rejects(x=>{x.budget[name]=max+1;});rejects(x=>{x.budget[name]=0;});rejects(x=>{x.budget[name]=-1;});
  rejects(x=>{x.budget[name]=1.5;});rejects(x=>{x.budget[name]=String(max);});rejects(x=>{x.budget[name]=Number.MAX_SAFE_INTEGER+1;});
 }
 rejects(x=>{x.budget.candidates=50;x.budget.max_evaluations=49;});
 assert.throws(()=>expectedFoundationRequestV2(v2,0),code('INVALID_FOUNDATION_BUDGET'));assert.throws(()=>expectedFoundationRequestV2(v2,900001),code('INVALID_FOUNDATION_BUDGET'));assert.throws(()=>expectedFoundationRequestV2(v2,'900000'),code('INVALID_FOUNDATION_BUDGET'));
 assert.throws(()=>expectedFoundationRequestV2(edit(v2,x=>{x.max_evaluations+=1;}),900000),invalidContract);
});
test('U3 request: a request that drifts from its contract is rejected; getters and symbols are rejected',()=>{
 const {v2}=base,request=expectedFoundationRequestV2(v2,900000),drifts=change=>assert.throws(()=>validateFoundationResearchRequestV2(edit(request,change),v2),invalidContract);
 drifts(x=>{x.owner_id='someone-else';});drifts(x=>{x.bot_id='someone-else';});drifts(x=>{x.engine_hash='c'.repeat(64);});drifts(x=>{x.snapshot_hash='c'.repeat(64);});
 drifts(x=>{x.pending_dataset.content_digest='c'.repeat(64);});drifts(x=>{x.pending_dataset.metadata.start_time+=MINUTE;x.pending_dataset.metadata.total_bars-=1;});drifts(x=>{x.pending_dataset.metadata.warmup_bars+=1;});
 drifts(x=>{x.budget.candidates-=1;});drifts(x=>{x.budget.max_evaluations-=1;});drifts(x=>{x.budget.chunk_bars=500;});drifts(x=>{x.budget.max_output_bytes-=1;});drifts(x=>{x.budget.max_state_bytes-=1;});
 assert.throws(()=>validateFoundationResearchRequestV2(request,edit(v2,x=>{x.dataset.content_digest='nope';})),invalidContract);
 assert.throws(()=>validateFoundationResearchRequestV2(withGetter(request,'owner_id')),code('INVALID_FIELDS'));
 assert.throws(()=>validateFoundationResearchRequestV2(edit(request,x=>{x.budget=withGetter(x.budget,'candidates');})),code('INVALID_FIELDS'));
 assert.throws(()=>validateFoundationResearchRequestV2(withSymbol(request)),code('INVALID_FIELDS'));
 assert.throws(()=>validateFoundationResearchRequestV2(edit(request,x=>{x.pending_dataset[Symbol('extra')]=1;})),code('INVALID_FIELDS'));
 assert.throws(()=>validateFoundationResearchRequestV2(edit(request,x=>{x.pending_dataset.metadata.note=undefined;})),code('INVALID_FIELDS'));
});
test('U3 binding: parameters are exact, deterministic and derived from the contract',()=>{
 const {v2}=base,p=bind();
 assert.deepEqual(Object.keys(p).sort(),['bar_count','content_digest','dataset_sha256','execution_contract_hash','references','version']);
 assert.equal(p.version,'quant-research-dataset-binding-v1');assert.equal(p.content_digest,v2.dataset.content_digest);assert.equal(p.bar_count,COUNT);assert.equal(p.dataset_sha256,'9'.repeat(64));
 assert.deepEqual(Object.keys(p.references).sort(),['raw','sidecar']);
 assert.equal(canonical(bind()),canonical(p),'no token, attempt or time enters the parameters');
 assert.equal(canonical(validateDatasetBindingV1(v2,p)),canonical(p));
 const shuffled={execution_contract_hash:p.execution_contract_hash,bar_count:p.bar_count,content_digest:p.content_digest,dataset_sha256:p.dataset_sha256,references:{sidecar:p.references.sidecar,raw:p.references.raw},version:p.version};
 assert.equal(canonical(validateDatasetBindingV1(v2,shuffled)),canonical(p),'key order is not part of the binding');
 const frozen=structuredClone(p);Object.freeze(frozen);assert.notEqual(validateDatasetBindingV1(v2,frozen),frozen);
});
test('U3 binding rejects every field tamper: metadata, sidecar count/first_time/profile/tick/step, digest, extra key, non-hex, execution hash',()=>{
 const {v2}=base,p=bind(),rejects=(change,label)=>assert.throws(()=>validateDatasetBindingV1(v2,edit(p,change)),invalidBinding,label);
 for(const key of Object.keys(p))rejects(x=>{delete x[key];},'missing '+key);
 rejects(x=>{x.extra=1;},'extra key');rejects(x=>{x.version='quant-research-dataset-binding-v2';},'version');
 rejects(x=>{x.dataset_sha256='9'.repeat(63)+'A';},'dataset sha case');rejects(x=>{x.dataset_sha256='g'.repeat(64);},'dataset sha non-hex');rejects(x=>{x.dataset_sha256='9'.repeat(63);},'dataset sha short');rejects(x=>{x.dataset_sha256=9;},'dataset sha type');rejects(x=>{x.dataset_sha256='8'.repeat(64);},'dataset sha changed, execution hash stale');
 rejects(x=>{x.content_digest='a'.repeat(64);},'digest differs');rejects(x=>{x.content_digest='x';},'digest non-hex');rejects(x=>{x.bar_count+=1;},'count plus');rejects(x=>{x.bar_count-=1;},'count minus');rejects(x=>{x.bar_count=String(COUNT);},'count type');
 rejects(x=>{x.execution_contract_hash='a'.repeat(64);},'execution hash differs');rejects(x=>{x.execution_contract_hash='A'.repeat(64);},'execution hash case');rejects(x=>{x.execution_contract_hash=null;},'execution hash null');
 rejects(x=>{x.references.extra=1;},'references extra');rejects(x=>{delete x.references.raw;},'raw missing');rejects(x=>{delete x.references.sidecar;},'sidecar missing');
 const raw=x=>x.references.raw,side=x=>x.references.sidecar;
 for(const key of ['dataset_id','sha256','metadata'])rejects(x=>{delete raw(x)[key];},'raw missing '+key);
 rejects(x=>{raw(x).extra=1;},'raw extra');rejects(x=>{raw(x).dataset_id='e'.repeat(64);},'raw id differs from sha');rejects(x=>{raw(x).dataset_id=raw(x).sha256='e'.repeat(64);},'raw id and sha changed, execution hash stale');rejects(x=>{raw(x).sha256='E'.repeat(64);raw(x).dataset_id='E'.repeat(64);},'raw non-hex');
 for(const [name,value] of Object.entries(pendingMetadata(v2))){
  const other=typeof value==='number'?value+MINUTE:value+'x';
  rejects(x=>{raw(x).metadata[name]=other;},'metadata.'+name);rejects(x=>{delete raw(x).metadata[name];},'metadata missing '+name);
 }
 rejects(x=>{raw(x).metadata.extra=1;},'metadata extra');
 for(const key of Object.keys(p.references.sidecar))rejects(x=>{delete side(x)[key];},'sidecar missing '+key);
 rejects(x=>{side(x).extra=1;},'sidecar extra');rejects(x=>{side(x).sha256='f'.repeat(64);},'sidecar sha changed, execution hash stale');rejects(x=>{side(x).sha256='F'.repeat(64);},'sidecar sha case');
 rejects(x=>{side(x).bar_count+=1;},'sidecar count plus');rejects(x=>{side(x).bar_count-=1;},'sidecar count minus');
 rejects(x=>{side(x).first_time+=MINUTE;},'sidecar first_time later');rejects(x=>{side(x).first_time-=MINUTE;},'sidecar first_time earlier');
 rejects(x=>{side(x).profile='other-profile';},'sidecar profile');rejects(x=>{side(x).price_tick='0.1';},'sidecar tick');rejects(x=>{side(x).price_tick=0.01;},'sidecar tick as number');rejects(x=>{side(x).price_tick='0.010';},'sidecar tick text');
 rejects(x=>{side(x).quantity_step='0.01';},'sidecar step');rejects(x=>{side(x).quantity_step=0.001;},'sidecar step as number');
});
// The execution hash is restamped with the V1 shape written out here, so each contract-contradicting tamper below
// is rejected by its own check rather than by the stale execution hash.
const executionHash=(v2,p)=>hash(canonical({...v2,version:'ql3a-research-job-v1',dataset:{start_time:v2.dataset.start_time,end_time:v2.dataset.end_time,warmup_bars:v2.dataset.warmup_bars,bar_count:v2.dataset.bar_count,sha256:p.dataset_sha256,first_time:v2.dataset.first_time,references:p.references,timestamp_semantics:v2.dataset.timestamp_semantics}}));
const restamp=(v2,p)=>({...p,execution_contract_hash:executionHash(v2,p)});
test('U3 binding rejects restamped tampers that contradict the contract, one check at a time',()=>{
 const {v2}=base,p=bind();
 assert.equal(executionHash(v2,p),p.execution_contract_hash,'independent formula agrees with the module');
 const rejects=(change,label)=>assert.throws(()=>validateDatasetBindingV1(v2,restamp(v2,edit(p,change))),invalidBinding,label);
 const raw=x=>x.references.raw,side=x=>x.references.sidecar;
 assert.equal(validateDatasetBindingV1(v2,restamp(v2,edit(p,x=>{x.dataset_sha256='8'.repeat(64);side(x).sha256='7'.repeat(64);raw(x).dataset_id=raw(x).sha256='6'.repeat(64);}))).dataset_sha256,'8'.repeat(64),'file digests are opaque to the pure module; workers verify files');
 for(const [name,value] of Object.entries(pendingMetadata(v2))){
  const other=typeof value==='number'?value+MINUTE:value+'x';
  rejects(x=>{raw(x).metadata[name]=other;},'metadata.'+name);rejects(x=>{delete raw(x).metadata[name];},'metadata missing '+name);
 }
 rejects(x=>{raw(x).metadata.extra=1;},'metadata extra');rejects(x=>{raw(x).dataset_id='e'.repeat(64);},'raw id differs from sha');rejects(x=>{raw(x).extra=1;},'raw extra');
 rejects(x=>{side(x).bar_count+=1;},'sidecar count plus');rejects(x=>{side(x).bar_count-=1;},'sidecar count minus');rejects(x=>{side(x).bar_count=String(COUNT);},'sidecar count type');
 rejects(x=>{side(x).first_time+=MINUTE;},'sidecar first_time later');rejects(x=>{side(x).first_time-=MINUTE;},'sidecar first_time earlier');
 rejects(x=>{side(x).profile='other-profile';},'sidecar profile');
 rejects(x=>{side(x).price_tick='0.1';},'sidecar tick');rejects(x=>{side(x).price_tick=0.01;},'sidecar tick as number');rejects(x=>{side(x).price_tick='0.010';},'sidecar tick text');
 rejects(x=>{side(x).quantity_step='0.01';},'sidecar step');rejects(x=>{side(x).quantity_step=0.001;},'sidecar step as number');rejects(x=>{side(x).quantity_step='0.0010';},'sidecar step text');
 rejects(x=>{side(x).sha256='F'.repeat(64);},'sidecar sha case');rejects(x=>{side(x).sha256='f'.repeat(63);},'sidecar sha length');rejects(x=>{side(x).sha256=null;},'sidecar sha null');
 rejects(x=>{side(x).extra=1;},'sidecar extra');for(const key of Object.keys(p.references.sidecar))rejects(x=>{delete side(x)[key];},'sidecar missing '+key);
 rejects(x=>{x.dataset_sha256='G'.repeat(64);},'dataset sha non-hex');rejects(x=>{x.dataset_sha256='9'.repeat(63)+'A';},'dataset sha case');rejects(x=>{x.dataset_sha256=9;},'dataset sha type');
 rejects(x=>{x.content_digest='a'.repeat(64);},'content digest differs from the contract');rejects(x=>{x.bar_count+=1;},'bar count differs from the contract');rejects(x=>{x.bar_count-=1;},'bar count minus');
 rejects(x=>{x.references.extra=1;},'references extra');
 const otherDigest=edit(v2,x=>{x.dataset.content_digest='a'.repeat(64);});
 assert.throws(()=>validateDatasetBindingV1(otherDigest,p),invalidBinding,'binding belongs to its own contract (digest)');
 assert.throws(()=>validateDatasetBindingV1(edit(v2,x=>{x.engine_hash='b'.repeat(64);}),p),invalidBinding,'binding belongs to its own contract (engine hash)');
 assert.throws(()=>validateDatasetBindingV1(edit(v2,x=>{x.model.price_tick=0.05;}),p),invalidBinding,'binding belongs to its own contract (tick)');
});
test('U3 binding: getters, symbols and non-plain values are rejected; bad contracts are reported as contract errors',()=>{
 const {v2}=base,p=bind(),rejects=value=>assert.throws(()=>validateDatasetBindingV1(v2,value),invalidBinding);
 rejects(withGetter(p,'dataset_sha256'));rejects(withSymbol(p));
 rejects(edit(p,x=>{x.references=withGetter(x.references,'raw');}));rejects(edit(p,x=>{x.references.sidecar=withGetter(x.references.sidecar,'sha256');}));rejects(edit(p,x=>{x.references.raw.metadata=withGetter(x.references.raw.metadata,'symbol');}));
 rejects(edit(p,x=>{x.references.sidecar[Symbol('extra')]=1;}));
 for(const bad of [null,undefined,'binding',7,[],[p],new Map()])rejects(bad);
 class Custom{constructor(value){Object.assign(this,value);}}
 rejects(new Custom(p));rejects(edit(p,x=>{x.references=new Custom(x.references);}));
 assert.throws(()=>validateDatasetBindingV1(edit(v2,x=>{x.dataset.bars=[];}),p),invalidContract);
 assert.throws(()=>validateDatasetBindingV1(null,p),invalidContract);
 assert.throws(()=>datasetBindingParameters(edit(v2,x=>{x.version='ql3a-research-job-v1';}),{references:syntheticReferences(v2),dataset_sha256:'9'.repeat(64)}),invalidContract);
 assert.throws(()=>materializeExecutionContract(edit(v2,x=>{delete x.plan;}),p),invalidContract);
 assert.throws(()=>datasetBindingIdentity(undefined,p),invalidContract);
});
test('U3 binding builder: refuses references and digests the contract does not allow',()=>{
 const {v2}=base,refs=syntheticReferences(v2),sha='9'.repeat(64),make=(references,dataset_sha256)=>()=>datasetBindingParameters(v2,{references,dataset_sha256});
 assert.throws(()=>datasetBindingParameters(v2),invalidBinding);assert.throws(()=>datasetBindingParameters(v2,{}),invalidBinding);assert.throws(()=>datasetBindingParameters(v2,null),invalidBinding);assert.throws(()=>datasetBindingParameters(v2,'refs'),invalidBinding);assert.throws(()=>buildResearchContractV2(null),invalidContract);
 assert.throws(make(undefined,sha),invalidBinding);assert.throws(make(refs,undefined),invalidBinding);assert.throws(make(refs,'nope'),invalidBinding);assert.throws(make(refs,'9'.repeat(64)+'0'),invalidBinding);
 assert.throws(make({raw:refs.raw},sha),invalidBinding);assert.throws(make({...refs,extra:1},sha),invalidBinding);
 assert.throws(make({raw:{...refs.raw,metadata:{...refs.raw.metadata,total_bars:COUNT+1}},sidecar:refs.sidecar},sha),invalidBinding);
 assert.throws(make({raw:refs.raw,sidecar:{...refs.sidecar,bar_count:COUNT-1}},sha),invalidBinding);assert.throws(make({raw:refs.raw,sidecar:{...refs.sidecar,profile:'x'}},sha),invalidBinding);
 assert.throws(make(withGetter(refs,'raw'),sha),invalidBinding);assert.throws(make(withSymbol(refs),sha),invalidBinding);
 assert.throws(()=>datasetBindingParameters(v2,{references:refs,dataset_sha256:sha,extra:1}),invalidBinding,'no unknown input keys such as a token or an attempt');
});
test('U3 materialize: V1 shape from a validated binding only; copies never alias the inputs',()=>{
 const {v2}=base,p=bind(),execution=materializeExecutionContract(v2,p);
 assert.equal(execution.version,'ql3a-research-job-v1');assert.equal(execution.execution_backend,'quant-foundation-v1');
 assert.deepEqual(Object.keys(execution.dataset).sort(),['bar_count','end_time','first_time','references','sha256','start_time','timestamp_semantics','warmup_bars']);
 assert.equal(execution.dataset.sha256,p.dataset_sha256);assert.deepEqual(execution.dataset.references,p.references);
 for(const key of ['content_digest','digest_version','bars'])assert.equal(Object.hasOwn(execution.dataset,key),false,key);
 for(const [key,value] of Object.entries(v2))if(!['version','dataset'].includes(key))assert.deepEqual(execution[key],value,key);
 assert.equal(hash(canonical({...execution,version:'ql3a-research-job-v1'})),hash(canonical(execution)));
 assert.equal(p.execution_contract_hash,hash(canonical(execution)),'the binding pins the exact execution contract');
 execution.dataset.references.raw.dataset_id='0'.repeat(64);execution.snapshot.selection={};
 assert.equal(p.references.raw.dataset_id,'d'.repeat(64));assert.notDeepEqual(v2.snapshot.selection,{});
 assert.throws(()=>materializeExecutionContract(v2,edit(p,x=>{x.dataset_sha256='8'.repeat(64);})),invalidBinding);
 assert.throws(()=>materializeExecutionContract(v2,edit(p,x=>{x.references.sidecar.first_time+=MINUTE;})),invalidBinding);
 assert.throws(()=>materializeExecutionContract(v2,undefined),invalidBinding);
});
test('U3 binding identity: the chunk-row identity formula over the stored V2 contract, stable and tamper-checked',()=>{
 const {v2}=base,p=bind();
 assert.equal(datasetBindingIdentity(v2,p),hash(canonical({contract:v2,parameters:p,kind:'PREPARE'})));
 assert.equal(datasetBindingIdentity(v2,p),datasetBindingIdentity(structuredClone(v2),structuredClone(p)));
 const shuffled={version:p.version,references:{sidecar:p.references.sidecar,raw:p.references.raw},execution_contract_hash:p.execution_contract_hash,dataset_sha256:p.dataset_sha256,content_digest:p.content_digest,bar_count:p.bar_count};
 assert.equal(datasetBindingIdentity(v2,shuffled),datasetBindingIdentity(v2,p));
 const other=buildV2(base.env,{engine_hash:'b'.repeat(64)});
 assert.notEqual(datasetBindingIdentity(other,bind(other)),datasetBindingIdentity(v2,p));
 assert.notEqual(datasetBindingIdentity(v2,p),datasetBindingIdentity(v2,restamp(v2,edit(p,x=>{x.dataset_sha256='8'.repeat(64);}))));
 assert.throws(()=>datasetBindingIdentity(v2,edit(p,x=>{x.bar_count+=1;})),invalidBinding);assert.throws(()=>datasetBindingIdentity(edit(v2,x=>{x.scope='x';}),p),invalidContract);
});
const stripComments=text=>text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
const ALLOWED_IMPORTS={'../pine-bridge/source.js':'{canonical,fail,hash,keys}','./foundation-contract.js':'{FOUNDATION_LIMITS,validateDatasetMetadata,validateDatasetReference}','./foundation-contract-v2.js':'{strictJsonV2}'};
const FORBIDDEN=[/\brequire\b/,/\bprocess\b/,/\bglobalThis\b/,/\beval\b/,/\bnew\s+Function\b/,/\bfetch\b/,/\bDate\b/,/\bperformance\b/,/\bhrtime\b/,/\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b/,/random/i,/\bcrypto\b/,/\bfs\b|\bnode:/,/\basync\b|\bawait\b|\bPromise\b/,/\bconsole\b/];
// Returns every boundary violation found in a module text: the exact import list, exact named bindings and forbidden globals.
function boundaryProblems(text){
 const code=stripComments(text),problems=[];
 const imports=[...code.matchAll(/^import\s+([\s\S]*?)\s+from\s+'([^']+)';?$/gm)].map(match=>[match[2],match[1].replace(/\s+/g,'')]);
 if(JSON.stringify(imports.map(([specifier])=>specifier).sort())!==JSON.stringify(Object.keys(ALLOWED_IMPORTS).sort()))problems.push('import list');
 for(const [specifier,bindings] of imports)if(ALLOWED_IMPORTS[specifier]!==bindings)problems.push('bindings of '+specifier);
 if((code.match(/\bimport\b/g)??[]).length!==3)problems.push('import keyword count');
 for(const pattern of FORBIDDEN)if(pattern.test(code))problems.push('forbidden '+pattern);
 return problems;
}
test('import boundary: only source.js, foundation-contract.js and foundation-contract-v2.js (strictJsonV2) are imported',async()=>{
 const text=await fs.readFile(moduleFile,'utf8');
 assert.deepEqual(boundaryProblems(text),[]);
 assert.deepEqual(Object.keys(ALLOWED_IMPORTS).sort(),['../pine-bridge/source.js','./foundation-contract-v2.js','./foundation-contract.js']);
});
test('import boundary checker detects an extra import, a node builtin, a wider binding, and clock, random or process use',async()=>{
 const text=await fs.readFile(moduleFile,'utf8'),tail="import {strictJsonV2} from './foundation-contract-v2.js';\n";
 assert.ok(text.includes(tail));
 const cases={
  'extra import':text.replace(tail,tail+"import {D} from '../money.js';\n"),
  'node builtin import':text.replace(tail,tail+"import {readFileSync} from 'node:fs';\n"),
  'wider binding':text.replace("import {strictJsonV2} from","import {strictJsonV2,frozenV2} from"),
  'dynamic import':text.replace('export function contentDigest(rows){\n','export function contentDigest(rows){\n import(\'../money.js\');\n'),
  'clock':text.replace('export function contentDigest(rows){\n','export function contentDigest(rows){\n Date.now();\n'),
  'random':text.replace('export function contentDigest(rows){\n','export function contentDigest(rows){\n Math.random();\n'),
  'process':text.replace('export function contentDigest(rows){\n','export function contentDigest(rows){\n process.env.X;\n'),
  'async':text.replace('export function contentDigest(rows){','export async function contentDigest(rows){'),
 };
 for(const [name,mutated] of Object.entries(cases)){assert.notEqual(mutated,text,name);assert.notDeepEqual(boundaryProblems(mutated),[],name);}
 assert.deepEqual(boundaryProblems(text.replace('/** Ordered content digest','/** Uses Date, process and fetch only in prose. Ordered content digest')),[],'comments do not count');
});
const deepFreeze=value=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.freeze(value);Object.values(value).forEach(deepFreeze);}return value;};
test('purity: deterministic, synchronous, input-preserving, and independent of clock and randomness',()=>{
 const env=environment(),input=buildInput(env),rows=env.rows.slice(0,200).map(row=>({bar_time:row.bar_time,content_hash:row.content_hash}));
 deepFreeze(input);deepFreeze(rows);
 const references=syntheticReferences(base.v2);deepFreeze(references);
 const run=()=>{
  const contract=buildResearchContractV2(input),binding=datasetBindingParameters(contract,{references,dataset_sha256:'9'.repeat(64)}),request=expectedFoundationRequestV2(contract,900000);
  return {digest:contentDigest(rows),contract,request,checkedRequest:validateFoundationResearchRequestV2(request,contract),metadata:pendingMetadata(contract),binding,checkedBinding:validateDatasetBindingV1(contract,binding),execution:materializeExecutionContract(contract,binding),identity:datasetBindingIdentity(contract,binding),recontract:validateResearchContractV2(contract)};
 };
 const plain=run(),trap=()=>{throw new Error('impure call');},saved={now:Date.now,random:Math.random,hrtime:process.hrtime,Date:globalThis.Date};
 let trapped;
 try{
  saved.Date.now=trap;Math.random=trap;process.hrtime=trap;
  globalThis.Date=class extends saved.Date{constructor(){super();trap();}};
  trapped=run();
 }finally{
  globalThis.Date=saved.Date;saved.Date.now=saved.now;Math.random=saved.random;process.hrtime=saved.hrtime;
 }
 assert.equal(globalThis.Date,saved.Date);assert.equal(Date.now,saved.now);assert.equal(Math.random,saved.random);assert.equal(process.hrtime,saved.hrtime,'the traps are removed for every later test in a shared process');
 assert.equal(canonical(trapped),canonical(plain),'same inputs give the same bytes with the clock and randomness disabled');
 for(const value of Object.values(plain))assert.equal(value instanceof Promise,false);
 for(const [name,value] of Object.entries(contractV2))if(typeof value==='function')assert.equal(Object.getPrototypeOf(value).constructor.name,'Function','synchronous export '+name);
 assert.notEqual(plain.contract,plain.recontract);assert.notEqual(plain.binding,plain.checkedBinding);
 assert.equal(canonical(plain.recontract),canonical(plain.contract));
});
// PostgreSQL JSONB returns keys shorter-first, so rows read back are not in insertion order. Only canonical bytes may matter.
const jsonbOrder=value=>Array.isArray(value)?value.map(jsonbOrder):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort((a,b)=>a.length-b.length||(a<b?-1:1)).map(key=>[key,jsonbOrder(value[key])])):value;
test('rows read back from JSONB in another key order validate and keep identity, hashes and materialization',()=>{
 const {v2}=base,p=bind(),readV2=jsonbOrder(JSON.parse(JSON.stringify(v2))),readP=jsonbOrder(JSON.parse(JSON.stringify(p)));
 assert.notEqual(JSON.stringify(readV2),JSON.stringify(v2),'the round trip really changed key order');
 assert.equal(canonical(validateResearchContractV2(readV2)),canonical(v2));
 assert.equal(hash(canonical(validateResearchContractV2(readV2))),hash(canonical(v2)),'contract_hash is stable across the row round trip');
 assert.equal(canonical(validateDatasetBindingV1(readV2,readP)),canonical(p));
 assert.equal(datasetBindingIdentity(readV2,readP),datasetBindingIdentity(v2,p));
 assert.equal(canonical(materializeExecutionContract(readV2,readP)),canonical(materializeExecutionContract(v2,p)));
 const request=expectedFoundationRequestV2(v2,900000);
 assert.equal(canonical(validateFoundationResearchRequestV2(jsonbOrder(JSON.parse(JSON.stringify(request))),readV2)),canonical(request));
});
