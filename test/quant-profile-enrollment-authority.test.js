import test from 'node:test';
import assert from 'node:assert/strict';
import {canonical,hash,fail} from '../src/pine-bridge/source.js';
import {capacityPolicyHash} from '../src/quant-research/capacity-contract.js';
import {QuantProfileService} from '../src/postgres/quant-profile.js';
import {QuantDataService} from '../src/postgres/quant-data.js';
import {createProfileEnrollmentTicketAuthority} from '../src/postgres/quant-profile-enrollment-ticket.js';
import {loadQuantProfileEnrollmentSchemaAssertion} from '../src/postgres/quant-profile-enrollment-migration.js';
import {profileV2Fixture} from './helpers/profile-v2-fixture.js';
import {fixture as inputsFixture,source as sourceText} from './helpers/quant-research-fixture.mjs';
async function fixture(){
 const {policy,contract}=profileV2Fixture(600);policy.environment='staging';
 policy.terminal={version:'quant-io-terminal-policy-v1',runtime_max_ms:70000,terminal_drain_ms:45000,tail_margin_ms:5000};
 const analysis=inputsFixture().analysis;
 Object.assign(policy.scope,{source_hash:hash(sourceText),settings_hash:analysis.effective_inputs_hash});
 Object.assign(contract.profile,{source_hash:policy.scope.source_hash,effective_inputs_hash:policy.scope.settings_hash});
 contract.capacity.scope=structuredClone(policy.scope);contract.capacity.environment='staging';contract.capacity.policy_hash=capacityPolicyHash(policy);contract.completion_mode='pf2-enrollment-v1';
 const market={broker:'binance-global',symbol:'BTCUSDT',timeframe:'1'};
 const model={...contract.profile.execution_model};for(const name of ['price_tick','quantity_step','fee_bps','slippage_bps','risk_percent'])model[name]=Number(model[name]);
 contract.profile.execution_model=model;
 contract.profile.metadata_hash=hash(canonical({market,price_tick:String(model.price_tick),quantity_step:String(model.quantity_step),data_profile:model.data_profile}));
 const source={source:sourceText,source_hash:hash(sourceText),analysis};
 const members=[{pine_import_id:'fixture-import',source_version:1,source_hash:source.source_hash,analysis:structuredClone(analysis)}];
 const risk={paperTrading:true,requireReduceOnlySell:true},capital=[{broker:'binance-global',configuredEquity:1000,configuredBalance:1000}];
 const snapshot={membership:structuredClone(members),policy:structuredClone(risk),policy_hash:hash(canonical(risk)),capital:structuredClone(capital),funding_cutoff:0,market,source_hash:source.source_hash,artifact_hash:hash('artifact'),selection:{signals:{buy:'buySignal',exit:'sellSignal',timing:'bar_close'}}};
 const snapshotHash=hash(canonical(snapshot));contract.snapshot_hash=contract.profile.snapshot_hash=snapshotHash;
 const evidence={snapshot_hash:snapshotHash,artifact_hash:snapshot.artifact_hash,source_hash:snapshot.source_hash,compilation_errors:0,warnings:0,reviewed_warnings:0,binding_coverage:100,source_changed_bytes:0,unresolved_references:0,identifier_collisions:0,duplicate_bindings:0,native_alerts_isolated:true,effective_inputs_reviewed:true,signals_reviewed:true,cases:{sl:10,tp:10,native_and_bridge:5,both_touched:5,rejected:5,capped:5,buy:1,targeted_exit:1,duplicate_delivery:1},decision_match_percent:100,duplicate_ledger_effects:0,unrelated_payloads:0,level_difference_ticks:0,execution_model:model,references:{tradingview:'synthetic fixture',source_review:'synthetic fixture',paper_fixture:'synthetic fixture'}};
 const provenance={fixture:'backfill'};contract.profile.raw_provenance_sha256=hash(canonical(provenance));
 const job={job_id:'11111111-1111-4111-8111-111111111112',owner_id:contract.owner_id,contract:structuredClone(contract),contract_hash:hash(canonical(contract)),status:'RUNNING',lease_token:'22222222-2222-4222-8222-222222222222',stop_reason:null,checkpoint:null,next_bar:0,result:null};
 const state={job,source,members,risk,capital,funding:0,session:{locked_policy:null},revoked:false,transaction:false,epoch:{},reads:0,sql:[],deployment:{deployment_id:contract.profile.deployment_id,pine_import_id:'fixture-import',source_version:1,state:'READY',snapshot,snapshot_hash:snapshotHash},evidence:{evidence,snapshot_hash:snapshotHash,evidence_hash:hash(canonical(evidence))},raw:{result:{dataset:structuredClone(contract.dataset),provenance}}};
 const db={get isTransaction(){return state.transaction;},query:async(sql)=>{
  state.sql.push(sql);if(state.sqlError)throw state.sqlError;
  if(sql==='SHOW transaction_isolation')return {rows:[{transaction_isolation:state.isolation??'serializable'}]};
  if(sql.includes('quant_foundation_jobs'))return {rows:[state.job]};
  if(sql.includes('pine_deployments'))return {rows:[{deployment_id:state.deployment.deployment_id}]};
  if(sql.includes('FROM users'))return {rows:[{id:contract.owner_id}]};
  throw Error('Unexpected query: '+sql);
 },prepare:sql=>({get:async()=>{
  state.sql.push(sql);
  if(sql.includes('pine_deployments'))return state.deployment;
  if(sql.includes('pine_bridge_evidence'))return state.evidence;
  if(sql.includes('paper_funding'))return {cutoff:state.funding};
  throw Error('Unexpected prepared query: '+sql);
 },all:async()=>{state.sql.push(sql);if(sql.includes('pine_memberships'))return state.members;throw Error('Unexpected all');}})};
 const pine={db,store:{getBotSession:async()=>state.session,risk:async()=>state.risk,paperAccounts:async()=>state.capital},authorize:async(owner,bot)=>{if(state.revoked||owner!==contract.owner_id||bot!==contract.bot_id)throw fail('NOT_FOUND',404);},source:async()=>state.source};
 const data={db,pine,scope:QuantDataService.prototype.scope,datasetStore:{inspect:async()=>{throw Error('Unexpected filesystem inspection');}}};
 const tickets=createProfileEnrollmentTicketAuthority({readExecutableHash:async()=>{state.reads++;return contract.engine_hash;},releaseGuard:()=>state.epoch,isTransaction:()=>state.transaction});
 const service=new QuantProfileService({pineService:pine,dataService:data,capacityPolicy:policy,profileV2Enabled:true,enrollmentEnabled:true,supportedSourceHash:hash(sourceText),enrollmentTicketVerifier:tickets.assert});
 service.rawRow=async()=>state.raw;
 service.ready=async()=>{throw Error('Unexpected ready filesystem checks');};
 const ticket=await tickets.prepare({job,leaseToken:job.lease_token,operationId:'operation-001',payloadHash:hash('payload'),policy});
 const context={jobId:job.job_id,leaseToken:job.lease_token,executionTicket:ticket,phase:'BEGIN'};
 state.transaction=true;return {service,contract,state,tickets,context};
}
test('BEGIN and FINALIZE revalidate persisted SQL authority without hashing or artifact inspection',async()=>{
 const {service,contract,state,tickets,context}=await fixture();
 assert.deepEqual(await service.authorizeEnrollmentLocked(contract.owner_id,contract,context),{ok:true});assert.equal(state.reads,1);
 assert.ok(state.sql.some(sql=>sql.includes('users')&&sql.includes('FOR UPDATE')));assert.ok(state.sql.some(sql=>sql.includes('pine_deployments')&&sql.includes('FOR SHARE')));
 state.transaction=false;context.executionTicket=await tickets.refresh(context.executionTicket);context.phase='FINALIZE';state.transaction=true;
 state.job.status='STOPPING';state.job.stop_reason='PROFILE_COMPLETING';
 assert.deepEqual(await service.authorizeEnrollmentLocked(contract.owner_id,contract,context),{ok:true});assert.equal(state.reads,2);
});
test('locked authority rejects owner, raw, source, review, deployment, membership, policy and capital revocation',async()=>{
 for(const mutate of [
 s=>s.revoked=true,s=>s.job.owner_id='foreign',s=>s.job.lease_token='other-token',s=>s.job.contract_hash=hash('other'),s=>s.job.checkpoint={},s=>s.job.result={},s=>s.job.next_bar=1,
 s=>s.raw.result.provenance.extra=true,s=>s.raw.result.dataset.sha256=hash('other'),s=>s.source.source='changed',s=>s.source.source_hash=hash('other'),s=>s.source.analysis.effective_inputs_hash=hash('other'),s=>delete s.source.analysis.effective_input_review,s=>s.source.analysis.inputs[0].effective_value='changed',
 s=>s.deployment.state='REVOKED',s=>s.deployment.snapshot_hash=hash('other'),s=>s.members=[],s=>s.risk.paperTrading=false,s=>s.capital[0].configuredBalance++,s=>s.funding++,s=>s.session.locked_policy=JSON.stringify({paperTrading:false}),s=>s.evidence.evidence.execution_model.fee_bps++,
 ]){const {service,contract,state,context}=await fixture();mutate(state);assert.deepEqual(await service.authorizeEnrollmentLocked(contract.owner_id,contract,context),{ok:false},String(mutate));assert.equal(state.reads,1);}
});
test('locked authority requires serializable transaction, flags, private ticket, exact phase and current policy',async()=>{
 for(const mutate of [f=>f.state.transaction=false,f=>f.state.isolation='read committed',f=>f.service.enrollmentEnabled=false,f=>f.service.profileV2Enabled=false,f=>f.service.enrollmentTicketVerifier=undefined,f=>f.context.executionTicket={},f=>f.context.phase='OTHER',f=>f.state.epoch={},f=>f.service.capacityPolicy={...f.service.capacityPolicy,scope:{...f.service.capacityPolicy.scope,evaluator_hash:hash('other')}}]){
  const f=await fixture();mutate(f);assert.deepEqual(await f.service.authorizeEnrollmentLocked(f.contract.owner_id,f.contract,f.context),{ok:false});
 }
});
test('database failures propagate instead of controlled authority denial',async()=>{
 const f=await fixture(),error=Object.assign(Error('serialization failure'),{code:'40001'});f.state.sqlError=error;
 await assert.rejects(f.service.authorizeEnrollmentLocked(f.contract.owner_id,f.contract,f.context),e=>e===error);
});
test('ordinary raw inspection remains required, and preloaded schema assertion requires transaction and relation locks',async()=>{
 const f=await fixture();let inspections=0;f.service.data.datasetStore.inspect=async()=>{inspections++;};
 await f.service.raw(f.contract.owner_id,f.contract.bot_id,f.contract.profile.raw_job_id);assert.equal(inspections,1);
 const assertLocked=await loadQuantProfileEnrollmentSchemaAssertion();const sql=[];
 await assert.rejects(assertLocked({isTransaction:false}),{code:'PROFILE_ENROLLMENT_TRANSACTION_REQUIRED'});
 await assert.rejects(assertLocked({isTransaction:true,query:async command=>{sql.push(command);return {rows:[]};}}),{code:'QUANT_PROFILE_ENROLLMENT_SCHEMA_UNSUPPORTED'});
 assert.equal(sql[0],'LOCK TABLE public.quant_profile_enrollment_schema IN SHARE MODE');assert.equal(sql[1],'LOCK TABLE public.quant_profile_enrollment_receipts IN SHARE ROW EXCLUSIVE MODE');
});
